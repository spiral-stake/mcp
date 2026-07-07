// Pendle — PT implied APY. Port of the fetchPendleMarkets helper in api-services/apy.ts.
// The composition matches a collateral PT by `pt === "1-<address lowercased>"` and reads
// `details.impliedApy` (a fraction; ×100 → %).
import { getJson } from "./http.ts";

export interface PendleMarket {
  pt?: string; // e.g. "1-0xabc…" (chainId-address)
  details?: { impliedApy?: number };
  [key: string]: unknown;
}

export async function fetchPendleMarkets(): Promise<PendleMarket[]> {
  const data = await getJson<{ markets?: PendleMarket[] }>(
    "https://api-v2.pendle.finance/core/v1/markets/all?isActive=true&chainId=1",
    { source: "pendle", retries: 2 },
  );
  return data.markets ?? [];
}
