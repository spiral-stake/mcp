// App-surface: the full composed internal `Market[]`, serialized for the v2-client app to consume
// in place of its own client-side composition. Unlike the agent-facing `/v1/strategies` (curated,
// lossy, string APYs), this exposes the RAW domain model — BigNumber and bigint values are tagged
// so the app revives them with exact precision (liquidation-price / leverage math depend on it).
import BigNumber from "bignumber.js";
import { composeSnapshot } from "../core/compose.ts";

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

export function buildAppMarkets(chainId: number) {
  const snap = composeSnapshot(chainId);
  const markets = snap.markets.map((cm) => cm.market);
  return { asOf: snap.asOf, chainId, count: markets.length, markets: tagize(markets) };
}
