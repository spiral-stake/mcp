// GeckoTerminal — DEX OHLCV for collateral that neither CoinGecko's market_chart nor TradingView
// charts yet (new Robinhood Chain launches: CASHCAT, PONS). Public API: ~30 req/min per IP, no key,
// attribution required ("via GeckoTerminal" in the UI). The same paths exist on CoinGecko's paid
// onchain surface; setting COINGECKO_PRO_API_KEY flips the base URL and lifts the limit to
// 300–500 req/min without touching any caller — that is the planned upgrade path.
//
// This layer only fetches + parses. Caching / coalescing lives in core/dexOhlcv.ts.
import { env } from "../config/env.ts";
import { ROBINHOOD_CHAIN_ID } from "../config/chains.ts";
import { getJson, UpstreamError } from "./http.ts";

// GeckoTerminal network slugs. A chain missing here has no DEX chart source (route → 400).
export const GT_NETWORK_BY_CHAIN: Record<number, string> = {
  1: "eth",
  [ROBINHOOD_CHAIN_ID]: "robinhood",
};

export const OHLCV_TIMEFRAMES = ["minute", "hour", "day"] as const;
export type OhlcvTimeframe = (typeof OHLCV_TIMEFRAMES)[number];
// The only aggregates GeckoTerminal accepts per timeframe; anything else is a 4xx upstream.
export const OHLCV_AGGREGATES: Record<OhlcvTimeframe, readonly number[]> = {
  minute: [1, 5, 15],
  hour: [1, 4, 12],
  day: [1],
};
export const OHLCV_MAX_LIMIT = 1000;

export interface DexPool {
  address: string;
  name: string; // e.g. "CASHCAT / WETH 0.3%"
  dex: string; // e.g. "uniswap-v4-robinhood"
  reserveUsd: number;
  // Which side of the pool the requested token sits on. OHLCV is quoted for one side, so this is
  // passed back as the `token=` param — otherwise a token that happens to be the quote leg would
  // chart the *other* asset's price.
  tokenSide: "base" | "quote";
}

// One candle, USD-quoted, `t` in unix seconds.
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ── Upstream budget ──────────────────────────────────────────────────────────
// The public API allows ~30 req/min per IP and answers the 31st with a 429 — which, for a range
// nobody has loaded yet, would surface as a blank chart. So every upstream call takes a slot from a
// sliding one-minute window (kept a little under the real cap); when the window is full callers wait
// for the oldest slot to age out, bounded so a flood fails fast rather than piling up. Fires straight
// through with the paid key's much larger budget.
const PUBLIC_BUDGET_PER_MIN = 25;
const PRO_BUDGET_PER_MIN = 250;
const WINDOW_MS = 60_000;
const MAX_WAIT_MS = 8_000;
const RETRY_429_DELAY_MS = 1_500;
let callTimes: number[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireSlot(): Promise<void> {
  const budget = env.COINGECKO_PRO_API_KEY ? PRO_BUDGET_PER_MIN : PUBLIC_BUDGET_PER_MIN;
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const now = Date.now();
    callTimes = callTimes.filter((t) => now - t < WINDOW_MS);
    if (callTimes.length < budget) {
      callTimes.push(now);
      return;
    }
    const waitMs = callTimes[0]! + WINDOW_MS - now + 5;
    if (now + waitMs > deadline) {
      throw new UpstreamError("GeckoTerminal request budget exhausted", "geckoterminal", 429);
    }
    await sleep(waitMs);
  }
}

// One budgeted GET. A 429 despite the budget (another instance sharing the IP, or the cap moving)
// gets exactly one retry after a short pause — enough to cross a window boundary, not enough to
// stack retries under load.
async function budgetedGet<T>(url: string, headers: Record<string, string>): Promise<T> {
  await acquireSlot();
  try {
    return await getJson<T>(url, { source: "geckoterminal", headers, timeoutMs: 10_000 });
  } catch (e) {
    if (!(e instanceof UpstreamError && e.status === 429)) throw e;
    await sleep(RETRY_429_DELAY_MS);
    await acquireSlot();
    return getJson<T>(url, { source: "geckoterminal", headers, timeoutMs: 10_000 });
  }
}

// Test hook.
export function _resetGeckoBudget() {
  callTimes = [];
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
// Uniswap v4 pools are 32-byte ids rather than addresses; GeckoTerminal keys them the same way.
const POOL_RE = /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/;

function endpoint(): { base: string; headers: Record<string, string> } {
  if (env.COINGECKO_PRO_API_KEY) {
    return {
      base: "https://pro-api.coingecko.com/api/v3/onchain",
      headers: { accept: "application/json", "x-cg-pro-api-key": env.COINGECKO_PRO_API_KEY },
    };
  }
  return {
    base: "https://api.geckoterminal.com/api/v2",
    headers: { accept: "application/json;version=20230302" },
  };
}

interface GtPoolsResponse {
  data?: {
    attributes?: { address?: string; name?: string; reserve_in_usd?: string };
    relationships?: {
      base_token?: { data?: { id?: string } };
      quote_token?: { data?: { id?: string } };
      dex?: { data?: { id?: string } };
    };
  }[];
}

// The deepest pool holding the token, or null when GeckoTerminal has none indexed. Depth (USD
// reserve), not volume, picks the pool: the deepest pool is the one whose price is hardest to push
// and therefore the most honest reference for a perp.
export async function fetchTopPool(network: string, token: string): Promise<DexPool | null> {
  const tokenLc = token.toLowerCase();
  if (!ADDRESS_RE.test(tokenLc)) throw new Error(`invalid token address: ${token}`);
  const { base, headers } = endpoint();

  let body: GtPoolsResponse;
  try {
    body = await budgetedGet<GtPoolsResponse>(`${base}/networks/${network}/tokens/${tokenLc}/pools?page=1`, headers);
  } catch (e) {
    // Unknown token → GeckoTerminal 404s. That is "no pool", not an outage.
    if (e instanceof UpstreamError && e.status === 404) return null;
    throw e;
  }

  const candidates: DexPool[] = [];
  for (const p of body.data ?? []) {
    const address = p.attributes?.address?.toLowerCase();
    if (!address || !POOL_RE.test(address)) continue;
    const baseId = p.relationships?.base_token?.data?.id?.toLowerCase() ?? "";
    const quoteId = p.relationships?.quote_token?.data?.id?.toLowerCase() ?? "";
    const tokenSide: DexPool["tokenSide"] | null = baseId.endsWith(`_${tokenLc}`)
      ? "base"
      : quoteId.endsWith(`_${tokenLc}`)
        ? "quote"
        : null;
    if (!tokenSide) continue;
    const reserveUsd = Number(p.attributes?.reserve_in_usd ?? 0);
    candidates.push({
      address,
      name: p.attributes?.name ?? address,
      dex: p.relationships?.dex?.data?.id ?? "unknown",
      reserveUsd: Number.isFinite(reserveUsd) ? reserveUsd : 0,
      tokenSide,
    });
  }
  candidates.sort((a, b) => b.reserveUsd - a.reserveUsd);
  return candidates[0] ?? null;
}

interface GtOhlcvResponse {
  data?: { attributes?: { ohlcv_list?: unknown[] } };
}

// Artifact guard. GeckoTerminal occasionally prints a candle that moves the price by tens of percent
// on negligible volume (seen: tokenized SPY, $761 → $900 on $180 of volume in an $8.5M pool, then a
// zero-volume candle carrying $900 forward). No real trade of that size moves a pool like that, so
// such a candle is flattened to the previous close (volume kept). "Dust" is judged against the pool's
// depth: moving a constant-product pool 10% takes roughly 5% of its reserve in volume, so a 10% candle
// on under 1% of reserve did not come from a trade in this pool. Real moves carry real volume and
// pass untouched — a meme token's genuine 30% candle on a $5M pool comes with six figures, not $180.
const SPIKE_MOVE = 0.1; // |close / prev close − 1| above this …
const SPIKE_RESERVE_FRACTION = 0.01; // … on volume under this share of the pool's USD reserve
export function sanitizeCandles(candles: Candle[], reserveUsd: number): Candle[] {
  if (candles.length < 2 || !(reserveUsd > 0)) return candles;
  const dustBelow = reserveUsd * SPIKE_RESERVE_FRACTION;
  const out: Candle[] = [candles[0]!];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = out[i - 1]!;
    const move = Math.abs(c.c / prev.c - 1);
    out.push(move > SPIKE_MOVE && c.v < dustBelow ? { t: c.t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: c.v } : c);
  }
  return out;
}

// USD candles for one pool side, oldest → newest. GeckoTerminal returns newest first and can
// include malformed rows on the live (still-open) candle — those are dropped rather than plotted.
export async function fetchPoolOhlcv(
  network: string,
  pool: DexPool,
  timeframe: OhlcvTimeframe,
  aggregate: number,
  limit: number,
): Promise<Candle[]> {
  const { base, headers } = endpoint();
  const url =
    `${base}/networks/${network}/pools/${pool.address}/ohlcv/${timeframe}` +
    `?aggregate=${aggregate}&limit=${limit}&currency=usd&token=${pool.tokenSide}`;
  const body = await budgetedGet<GtOhlcvResponse>(url, headers);

  const candles: Candle[] = [];
  for (const row of body.data?.attributes?.ohlcv_list ?? []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (![t, o, h, l, c, v].every(Number.isFinite) || t <= 0 || c <= 0) continue;
    candles.push({ t, o, h, l, c, v });
  }
  candles.sort((a, b) => a.t - b.t);
  return sanitizeCandles(candles, pool.reserveUsd);
}
