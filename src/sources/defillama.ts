// DeFiLlama yields — collateral APY + history for pools identified by `defillamaId`.
// Port of getTokenApyFromDefillama in api-services/apy.ts. Returns the raw `data.data` array
// of `{ timestamp, apy }` points (latest last); the composition reads the final point's apy.
//
// Also hosts the keyless price fallback used when CoinGecko is quota-exhausted (see sources/prices.ts).
import BigNumber from "bignumber.js";
import { getJson } from "./http.ts";

export interface DefillamaPoint {
  timestamp?: string | number;
  apy?: number | string;
  [key: string]: unknown;
}

export async function fetchDefillamaChart(defillamaId: string): Promise<DefillamaPoint[]> {
  const data = await getJson<{ data?: DefillamaPoint[] }>(
    `https://yields.llama.fi/chart/${defillamaId}`,
    { source: "defillama", retries: 2 },
  );
  return data.data ?? [];
}

// DeFiLlama attaches a 0..1 confidence to every price. Anything at or above this is treated as
// usable; below it we omit the token rather than publish a number we don't trust. Deliberately
// lenient — this source only ever runs when CoinGecko already failed, so being strict here means
// shipping NO price, which is the worse outcome (see sources/prices.ts).
const MIN_CONFIDENCE = 0.7;

interface LlamaCoin {
  price?: number;
  confidence?: number;
}

/**
 * USD prices from DeFiLlama's keyless coins API, addressed by CoinGecko id (`coingecko:usd-coin`)
 * so no chain/address mapping is needed — the ids already live in the token registry. Returns
 * address → price, omitting any token DeFiLlama couldn't price confidently.
 */
export async function fetchDefillamaPrices(
  tokens: { address: string; coingeckoId?: string }[],
): Promise<Record<string, BigNumber>> {
  const withId = tokens.filter((t) => t.coingeckoId) as { address: string; coingeckoId: string }[];
  if (withId.length === 0) return {};

  const keys = [...new Set(withId.map((t) => `coingecko:${t.coingeckoId}`))];
  const data = await getJson<{ coins?: Record<string, LlamaCoin> }>(
    `https://coins.llama.fi/prices/current/${encodeURIComponent(keys.join(","))}`,
    { source: "defillama-prices", retries: 2 },
  );

  const coins = data.coins ?? {};
  const prices: Record<string, BigNumber> = {};
  for (const token of withId) {
    const coin = coins[`coingecko:${token.coingeckoId}`];
    const price = coin?.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    if (coin?.confidence !== undefined && coin.confidence < MIN_CONFIDENCE) continue;
    prices[token.address] = BigNumber(price);
  }
  return prices;
}
