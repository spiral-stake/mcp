// DEX OHLCV for the app's price chart — on-demand (not warmed), because the key space
// (token × timeframe × aggregate × limit) is caller-driven. Everything that keeps the public
// GeckoTerminal limit (~30 req/min) from being exhausted lives here:
//
//   • pool resolution cached 1h (negative result 5m, so an unlisted token can't hammer upstream)
//   • candles cached per timeframe — 30s for minute candles (the app polls every 30s, so N viewers
//     ≈ 1 upstream call), 2m for hourly, 10m for daily: a daily candle doesn't change in 30s, and
//     refreshing it that often would spend the shared ~30 req/min budget on nothing
//   • in-flight coalescing — a burst of identical requests shares one upstream call
//   • last-good on failure — a 429/5xx serves the previous candles flagged `stale: true` (10 min for
//     intraday, 1h for daily) rather than blanking the chart; past that it fails so a dead upstream
//     is visible
//   • bounded LRU on every map, as the CoinGecko chart proxy does
//   • the upstream call itself is budgeted (sources/geckoterminal.ts) so a range nobody has cached
//     yet waits for a slot instead of 429ing
import {
  fetchPoolOhlcv,
  fetchTopPool,
  GT_NETWORK_BY_CHAIN,
  type Candle,
  type DexPool,
  type OhlcvTimeframe,
} from "../sources/geckoterminal.ts";
import { log } from "../config/logger.ts";

export const CANDLES_TTL_MS: Record<OhlcvTimeframe, number> = {
  minute: 30_000,
  hour: 2 * 60_000,
  day: 10 * 60_000,
};
export const CANDLES_STALE_GRACE_MS: Record<OhlcvTimeframe, number> = {
  minute: 10 * 60_000,
  hour: 10 * 60_000,
  day: 60 * 60_000,
};
const POOL_TTL_MS = 60 * 60_000;
const POOL_NEG_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;

export interface DexOhlcvRequest {
  chainId: number;
  token: string; // lower-cased 0x address
  timeframe: OhlcvTimeframe;
  aggregate: number;
  limit: number;
}

export interface DexOhlcvResponse {
  chainId: number;
  token: string;
  pool: { address: string; name: string; dex: string };
  timeframe: OhlcvTimeframe;
  aggregate: number;
  currency: "usd";
  source: "geckoterminal";
  asOf: string;
  stale: boolean;
  candles: Candle[];
}

// Thrown when the chain is charted but GeckoTerminal has no pool for the token (→ 404, not 503).
export class NoPoolError extends Error {
  constructor(token: string, chainId: number) {
    super(`No DEX pool indexed for ${token} on chain ${chainId}`);
    this.name = "NoPoolError";
  }
}

interface Entry<T> {
  at: number;
  value: T;
}

const poolCache = new Map<string, Entry<DexPool | null>>();
const candleCache = new Map<string, Entry<DexOhlcvResponse>>();
const inflight = new Map<string, Promise<DexOhlcvResponse>>();

// Insert with pruning: drop entries past `ttl`, then the oldest until under the cap. Map iteration
// is insertion-ordered, so the first key is the oldest.
function boundedSet<T>(map: Map<string, Entry<T>>, key: string, value: T, ttlMs: number) {
  const now = Date.now();
  for (const [k, e] of map) if (now - e.at >= ttlMs) map.delete(k);
  map.delete(key); // re-insert at the tail so a refreshed key is the newest, not the first evicted
  map.set(key, { at: now, value });
  while (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

async function resolvePool(network: string, chainId: number, token: string): Promise<DexPool | null> {
  const key = `${chainId}:${token}`;
  const hit = poolCache.get(key);
  if (hit) {
    const ttl = hit.value ? POOL_TTL_MS : POOL_NEG_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.value;
  }
  const pool = await fetchTopPool(network, token);
  boundedSet(poolCache, key, pool, POOL_TTL_MS);
  return pool;
}

export function isChartableChain(chainId: number): boolean {
  return chainId in GT_NETWORK_BY_CHAIN;
}

export async function getDexOhlcv(req: DexOhlcvRequest): Promise<DexOhlcvResponse> {
  const network = GT_NETWORK_BY_CHAIN[req.chainId];
  if (!network) throw new Error(`chain ${req.chainId} has no DEX chart source`);

  const key = `${req.chainId}:${req.token}:${req.timeframe}:${req.aggregate}:${req.limit}`;
  const ttlMs = CANDLES_TTL_MS[req.timeframe];
  const graceMs = CANDLES_STALE_GRACE_MS[req.timeframe];
  const hit = candleCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    try {
      const pool = await resolvePool(network, req.chainId, req.token);
      if (!pool) throw new NoPoolError(req.token, req.chainId);
      const candles = await fetchPoolOhlcv(network, pool, req.timeframe, req.aggregate, req.limit);
      const body: DexOhlcvResponse = {
        chainId: req.chainId,
        token: req.token,
        pool: { address: pool.address, name: pool.name, dex: pool.dex },
        timeframe: req.timeframe,
        aggregate: req.aggregate,
        currency: "usd",
        source: "geckoterminal",
        asOf: new Date().toISOString(),
        stale: false,
        candles,
      };
      boundedSet(candleCache, key, body, graceMs);
      return body;
    } catch (e) {
      // A missing pool is a fact about the token, not an outage — never mask it with stale data.
      if (e instanceof NoPoolError) throw e;
      const last = candleCache.get(key);
      if (last && Date.now() - last.at < graceMs) {
        log.warn("dex ohlcv upstream failed — serving last-good", {
          key,
          ageSec: Math.round((Date.now() - last.at) / 1000),
          error: e instanceof Error ? e.message : String(e),
        });
        return { ...last.value, stale: true };
      }
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}

// Test hook — the caches are module singletons.
export function _resetDexOhlcvCaches() {
  poolCache.clear();
  candleCache.clear();
  inflight.clear();
}
