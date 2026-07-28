// Token USD prices — availability-first orchestration over the individual price sources.
//
// Why this layer exists: prices are a `required: false` warm job, so the store is happy to serve
// an EMPTY map forever. That is not the same as degrading gracefully. The app reads /v1/prices to
// value the pay token in the deposit box; a missing price becomes `BigNumber(0)` client-side,
// which zeroes the USD readout, disables the max-leverage guard (0 > 0 is false), sends the MAX
// button through a divide-by-zero, and dead-ends the review overlay. So "no price" has to be a
// state we work hard to avoid, not one we shrug at.
//
// Two independent failures produced exactly that in production:
//
//   1. QUOTA. Each chain's warmer built its price list from the GLOBAL loanTokens registry
//      (data/markets.ts exports it unfiltered), so every chain requested the SAME id set. At
//      2 chains x 1 call / 5 min that is ~17.3k CoinGecko calls/month against a Demo key's
//      10k/month cap — over quota by design, so the key exhausted mid-month and every subsequent
//      refresh 429'd. Fixed by `dedupe()`: one upstream call per distinct id set, shared by all
//      chains, which also keeps the cost flat as chains are added.
//
//   2. NO FALLBACK. CoinGecko was the only source, so its exhaustion meant the job never primed
//      at all (`primed: false`, `asOf: null` — not even a stale last-good to fall back on).
//      Fixed by layering DeFiLlama's coins API underneath. It is keyless, so OUR quota cannot
//      exhaust it, and it accepts `coingecko:<id>` keys directly — the exact ids already carried
//      in the registry, so no address/chain mapping is involved.
//
//      Scope of that protection, precisely: DeFiLlama is an aggregation/cache layer, and for
//      these tokens it resolves to CoinGecko-derived data under DeFiLlama's OWN credentials
//      (verified: `ethereum:<addr>` and `coingecko:<id>` return byte-identical prices, so the
//      address form is not an independent derivation either). So this covers the failure we
//      actually had — our Demo key spending its 10k/month allowance — and any outage local to
//      our account or host. It does NOT cover a CoinGecko-wide outage; both layers would go
//      down together. A genuinely independent third tier (an on-chain DEX/oracle read) is the
//      next step if that risk matters, and is deliberately not attempted here.
//
// The two are merged rather than switched: DeFiLlama fills only the ids CoinGecko didn't return,
// so a partial CoinGecko response still contributes everything it has.
import BigNumber from "bignumber.js";
import { log } from "../config/logger.ts";
import { fetchTokenPrices } from "./coingecko.ts";
import { fetchDefillamaPrices } from "./defillama.ts";

export interface PriceToken {
  address: string;
  coingeckoId?: string;
}

// Distinct id sets are fetched once and shared. The window is just under the 5-minute price
// cadence so each refresh cycle still fetches fresh data — this collapses the simultaneous
// per-chain calls, it does not extend staleness. In-flight sharing is separate and unconditional,
// so two chains priming at the same instant await ONE request.
const DEDUPE_TTL_MS = 4 * 60 * 1000;

interface DedupeEntry {
  at: number;
  promise: Promise<Record<string, BigNumber>>;
  settled: boolean;
}
const inflight = new Map<string, DedupeEntry>();

function dedupe(
  key: string,
  run: () => Promise<Record<string, BigNumber>>,
): Promise<Record<string, BigNumber>> {
  const hit = inflight.get(key);
  // Reuse while in flight (any age), or while a settled result is still inside the window.
  if (hit && (!hit.settled || Date.now() - hit.at < DEDUPE_TTL_MS)) return hit.promise;

  const entry: DedupeEntry = { at: Date.now(), promise: run(), settled: false };
  inflight.set(key, entry);
  entry.promise
    .then((result) => {
      // An EMPTY map means every source failed. fetchTokenPricesResilient reports that by
      // resolving with {} rather than rejecting, so it would otherwise be cached as a perfectly
      // good answer and re-served for the whole dedupe window — turning one bad cycle into
      // several minutes of $0 prices even after the upstreams recover. Only cache real data.
      if (Object.keys(result).length === 0) {
        inflight.delete(key);
        return;
      }
      entry.settled = true;
      entry.at = Date.now();
    })
    // A rejection must NOT be cached either — the next chain/cycle retries immediately.
    .catch(() => inflight.delete(key));
  return entry.promise;
}

/**
 * USD prices for `tokens`, keyed by token address. Never throws: a token is simply absent when no
 * source could price it, matching the "omit rather than invent" convention the composition
 * expects (`priceOf` applies its own fallback). Returns `{}` only if BOTH sources fail.
 */
export async function fetchTokenPricesResilient(
  tokens: PriceToken[],
): Promise<Record<string, BigNumber>> {
  const withId = tokens.filter((t) => t.coingeckoId);
  if (withId.length === 0) return {};

  const key = [...new Set(withId.map((t) => t.coingeckoId!))].sort().join(",");

  return dedupe(key, async () => {
    let prices: Record<string, BigNumber> = {};

    try {
      prices = await fetchTokenPrices(withId);
    } catch (err) {
      // Expected and survivable (429 on quota exhaustion is the common case) — warn, don't throw.
      // DeFiLlama below is what keeps the job priming.
      log.warn("coingecko prices failed, falling back to defillama", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const missing = withId.filter((t) => prices[t.address] === undefined);
    if (missing.length === 0) return prices;

    try {
      const fallback = await fetchDefillamaPrices(missing);
      for (const [address, price] of Object.entries(fallback)) {
        if (prices[address] === undefined) prices[address] = price;
      }
      log.info("defillama filled missing prices", {
        requested: withId.length,
        fromCoingecko: withId.length - missing.length,
        fromDefillama: Object.keys(fallback).length,
      });
    } catch (err) {
      log.warn("defillama price fallback failed", {
        error: err instanceof Error ? err.message : String(err),
        stillMissing: missing.length,
      });
    }

    return prices;
  });
}

/** Test seam — clears the cross-chain dedupe cache. */
export function __resetPriceDedupe(): void {
  inflight.clear();
}
