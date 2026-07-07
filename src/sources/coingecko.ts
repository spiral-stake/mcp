// CoinGecko — loan/collateral USD prices + price charts. Ported from api-services/token.ts and
// api-services/chart.ts (getMarketChart). Uses the demo API key from env.
import BigNumber from "bignumber.js";
import { env } from "../config/env.ts";
import { getJson } from "./http.ts";

const CG_BASE = "https://api.coingecko.com/api/v3";

function keyParam(): string {
  return env.COINGECKO_API_KEY ? `&x_cg_demo_api_key=${env.COINGECKO_API_KEY}` : "";
}

// Fetch USD prices for a set of {address, coingeckoId}. Returns address → price (BigNumber),
// omitting any token whose price CoinGecko didn't return (matches the app).
export async function fetchTokenPrices(
  tokens: { address: string; coingeckoId?: string }[],
): Promise<Record<string, BigNumber>> {
  const withId = tokens.filter((t) => t.coingeckoId) as { address: string; coingeckoId: string }[];
  if (withId.length === 0) return {};

  const ids = [...new Set(withId.map((t) => t.coingeckoId))].join(",");
  const raw = await getJson<Record<string, { usd?: number }>>(
    `${CG_BASE}/simple/price?vs_currencies=usd&ids=${encodeURIComponent(ids)}${keyParam()}`,
    { source: "coingecko", retries: 2 },
  );

  const prices: Record<string, BigNumber> = {};
  for (const token of withId) {
    const price = raw[token.coingeckoId]?.usd;
    if (price != null) prices[token.address] = BigNumber(price);
  }
  return prices;
}

export interface MarketChartResponse {
  prices: [number, number][];
  market_caps: [number, number][];
  total_volumes: [number, number][];
}

export async function fetchMarketChart(
  coinId: string,
  days: number,
  currency: string,
): Promise<MarketChartResponse> {
  return getJson<MarketChartResponse>(
    `${CG_BASE}/coins/${coinId}/market_chart?vs_currency=${encodeURIComponent(currency)}&days=${days}${keyParam()}`,
    { source: "coingecko", retries: 2 },
  );
}
