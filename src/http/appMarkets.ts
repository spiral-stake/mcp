// App-surface: the full composed internal `Market[]`, serialized for the v2-client app to consume
// in place of its own client-side composition. Unlike the agent-facing `/v1/strategies` (curated,
// lossy, string APYs), this exposes the RAW domain model — BigNumber and bigint values are tagged
// so the app revives them with exact precision (liquidation-price / leverage math depend on it).
import BigNumber from "bignumber.js";
import { composeSnapshot } from "../core/compose.ts";
import { buildEquityMarkets } from "../core/equity.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS } from "../cache/policy.ts";

// Recursively tag BigNumber -> {$bn} and bigint -> {$bigint}; everything else is plain JSON.
// Detect BigNumber/bigint BEFORE descending so we never walk their internals.
export function tagize(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (BigNumber.isBigNumber(v)) return { $bn: v.toFixed() }; // toFixed() = full decimal, no exponential
  if (Array.isArray(v)) return v.map(tagize);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = tagize(val);
    return out;
  }
  return v;
}

// Per-group freshness of the upstreams behind these markets. `asOf` on the envelope is only the
// composition time (always "now"), which says nothing about how old the underlying data is — this
// does. A stale `borrow` group means maxLeverage/liquidity are out of date; a stale
// `collateralValue` group means liquidation prices are.
function freshnessOf(key: string) {
  const v = rawStore.view(key);
  if (!v) return null;
  return { asOf: v.asOf, staleAfterSec: v.staleAfterSec, staleForSec: v.staleForSec, degraded: v.degraded };
}

export function buildAppMarkets(chainId: number) {
  const snap = composeSnapshot(chainId);
  const loopMarkets = snap.markets.map((cm) => cm.market);
  // Append synthetic equity-vault strategies (composed from warmed stock-market data + the yield
  // loop already present in loopMarkets). Empty on chains without equity vaults.
  const markets = [...loopMarkets, ...buildEquityMarkets(chainId, loopMarkets)];
  return {
    asOf: snap.asOf,
    chainId,
    count: markets.length,
    freshness: {
      borrow: freshnessOf(KEYS.morphoMarkets(chainId)),
      collateralValue: freshnessOf(KEYS.onchainCollateralValue(chainId)),
      prices: freshnessOf(KEYS.prices(chainId)),
    },
    markets: tagize(markets),
  };
}
