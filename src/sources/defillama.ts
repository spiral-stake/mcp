// DeFiLlama yields — collateral APY + history for pools identified by `defillamaId`.
// Port of getTokenApyFromDefillama in api-services/apy.ts. Returns the raw `data.data` array
// of `{ timestamp, apy }` points (latest last); the composition reads the final point's apy.
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
