// Exit-liquidity slippage — measured LIVE, replacing the app's manual `npm run refresh:liquidity`.
// Ported from v2-client/scripts/refresh-exit-slippage.mjs. Kyberswap -> the chain's exit stable,
// keyless via x-client-id (per-chain slug + stable in CHAIN below); CoinGecko demo key for the
// fair-price fallback. Chains without a CHAIN entry are not measured. The warmer runs this on
// the 12h exit-liquidity cadence; compose overlays the results onto collateralTokens.json (the baked
// values stay the cold-start seed / per-token fallback).
//
// Semantics preserved from the script:
//  - fair unit price = a tiny probe's USDC output (ground truth), CoinGecko fallback, larger probe last.
//  - transient failure (429/5xx/network/timeout after retries) is OMITTED so the warmer keeps the
//    token's prior value; a definitive no-route writes all-null.
//  - PTs are measured via their underlying (the contract exits PT -> underlying -> stable).
import { env } from "../config/env.ts";
import type { Market } from "../types/index.ts";

const KYBER_BASE = "https://aggregator-api.kyberswap.com";
const CG_URL = "https://api.coingecko.com/api/v3/simple/price";

// Per-chain aggregator routing. Slug mirrors the app's chainConfig[chainId].name.toLowerCase()
// (and swap.ts); stable is the exit leg the leverage contract swaps into on that chain. A chain
// missing here is simply not measured — never quoted against the wrong chain (which returns
// "token not found" and would masquerade as a genuine no-route / "thin").
const CHAIN: Record<number, { slug: string; stable: string }> = {
  1: { slug: "ethereum", stable: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, // USDC
  4663: { slug: "robinhood", stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }, // USDG
};

const SIZES = {
  exitSlippage100k: 100_000,
  exitSlippage500k: 500_000,
  exitSlippage1M: 1_000_000,
  exitSlippage5M: 5_000_000,
} as const;
const PROBE_TOKENS = 1;
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 4;

// Explicit (not `keyof typeof SIZES`, which would inherit `readonly` from the `as const` above).
export type ExitSlippage = {
  exitSlippage100k?: number | null;
  exitSlippage500k?: number | null;
  exitSlippage1M?: number | null;
  exitSlippage5M?: number | null;
};
export type ExitLiquidityMap = Record<string, ExitSlippage>; // keyed by entry (collateral) address

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round2 = (n: number) => Math.round(n * 100) / 100;

function toBaseUnits(amount: number, dec: number): bigint {
  const [int, frac] = amount.toFixed(dec).split(".");
  return BigInt(int + (frac ?? "").padEnd(dec, "0").slice(0, dec));
}

interface FetchResult {
  status?: number;
  json?: any;
  transient?: true;
}
async function fetchRetry(url: string, headers: Record<string, string>): Promise<FetchResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return { status: res.status, json: await res.json().catch(() => null) };
    } catch {
      clearTimeout(timer);
      await sleep(1000 * 2 ** attempt);
    }
  }
  return { transient: true };
}

type Quote = { outUsd?: number; noRoute?: true; transient?: true };

async function quoteExit(chainId: number, tokenIn: string, dec: number, tokenAmount: number): Promise<Quote> {
  const cfg = CHAIN[chainId]!; // presence guaranteed by fetchExitLiquidity's chain guard
  const amountIn = toBaseUnits(tokenAmount, dec).toString();
  const url = `${KYBER_BASE}/${cfg.slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${cfg.stable}&amountIn=${amountIn}&gasInclude=false`;
  const r = await fetchRetry(url, { "x-client-id": "spiralstake" });
  if (r.transient) return { transient: true };
  if (r.status === 400 || r.status === 404 || r.status === 422) return { noRoute: true };
  if (r.status !== 200) return { transient: true };
  const outUsd = Number(r.json?.data?.routeSummary?.amountOutUsd);
  return Number.isFinite(outUsd) && outUsd > 0 ? { outUsd } : { noRoute: true };
}

async function coingeckoPrice(id?: string): Promise<number | null> {
  if (!id || !env.COINGECKO_API_KEY) return null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${CG_URL}?ids=${id}&vs_currencies=usd&x_cg_demo_api_key=${env.COINGECKO_API_KEY}`);
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) return null;
      const body = (await res.json()) as any;
      const p = Number(body?.[id]?.usd);
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch {
      await sleep(1500 * 2 ** attempt);
    }
  }
  return null;
}

async function fairPrice(
  chainId: number,
  address: string,
  dec: number,
  coingeckoId?: string,
): Promise<{ price?: number; transient?: true; noRoute?: true }> {
  const p1 = await quoteExit(chainId, address, dec, PROBE_TOKENS);
  if (p1.transient) return { transient: true };
  if (p1.outUsd) return { price: p1.outUsd / PROBE_TOKENS };
  const cg = await coingeckoPrice(coingeckoId);
  if (cg) return { price: cg };
  for (const n of [100, 1000]) {
    const q = await quoteExit(chainId, address, dec, n);
    if (q.transient) return { transient: true };
    if (q.outUsd) return { price: q.outUsd / n };
  }
  return { noRoute: true };
}

async function measureToken(
  chainId: number,
  address: string,
  dec: number,
  coingeckoId?: string,
): Promise<{ status: "ok" | "noroute" | "transient"; slippages?: ExitSlippage }> {
  const fp = await fairPrice(chainId, address, dec, coingeckoId);
  if (fp.transient) return { status: "transient" };
  if (fp.noRoute) {
    return { status: "noroute", slippages: Object.fromEntries(Object.keys(SIZES).map((k) => [k, null])) as ExitSlippage };
  }
  const slippages: ExitSlippage = {};
  for (const [field, targetUsd] of Object.entries(SIZES)) {
    const q = await quoteExit(chainId, address, dec, targetUsd / fp.price!);
    if (q.transient) return { status: "transient" };
    slippages[field as keyof ExitSlippage] = q.noRoute ? null : round2(((targetUsd - q.outUsd!) / targetUsd) * 100);
  }
  return { status: "ok", slippages };
}

async function pool<T, R>(items: T[], limit: number, worker: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

// Measure exit slippage for every collateral in `markets`. Returns a map keyed by the entry
// (collateral) address; transient tokens are omitted so the warmer keeps their prior value.
export async function fetchExitLiquidity(markets: Market[], chainId: number): Promise<ExitLiquidityMap> {
  // No aggregator config for this chain → don't measure (returning {} keeps prior/unmeasured).
  // Never quote a chain's tokens against the wrong chain: that returns "token not found", which the
  // no-route path would otherwise record as a genuine null → a false "thin" tier.
  if (!CHAIN[chainId]) return {};

  const targets = new Map<string, { address: string; decimals: number; coingeckoId?: string }>();
  const assignments: { entryAddress: string; measureKey: string }[] = [];
  const seen = new Set<string>();

  for (const m of markets) {
    const c = m.collateralToken;
    if (!c?.address) continue;
    const entryKey = c.address.toLowerCase();
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);

    // Measure the underlying for PTs (contract exits PT -> underlying -> stable).
    const src = c.isPt ? c.underlying : c;
    if (!src?.address || src.decimals == null) continue;
    const coingeckoId = c.isPt ? c.underlying?.coingeckoId : c.info?.coingeckoId;

    const measureKey = src.address.toLowerCase();
    if (!targets.has(measureKey)) {
      targets.set(measureKey, { address: src.address, decimals: src.decimals, coingeckoId });
    }
    assignments.push({ entryAddress: c.address, measureKey });
  }

  const targetList = [...targets.values()];
  const results = await pool(targetList, CONCURRENCY, async (t) => ({
    key: t.address.toLowerCase(),
    r: await measureToken(chainId, t.address, t.decimals, t.coingeckoId),
  }));
  const measured = new Map(results.map(({ key, r }) => [key, r]));

  const out: ExitLiquidityMap = {};
  for (const a of assignments) {
    const r = measured.get(a.measureKey);
    if (!r || r.status === "transient") continue; // omit -> warmer keeps the prior value
    out[a.entryAddress] = r.slippages!;
  }
  return out;
}
