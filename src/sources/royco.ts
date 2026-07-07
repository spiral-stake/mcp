// Royco vault API — APY + history for Royco vaults (vault address == collateral token address),
// which have no DeFiLlama/StableWatch pool. Port of getRoycoVaultApy / getRoycoVaultApyHistory in
// api-services/apy.ts. Requires ROYCO_API_KEY (x-api-key header).
import BigNumber from "bignumber.js";
import { env } from "../config/env.ts";
import { getJson } from "./http.ts";

const ROYCO_BASE = "https://vault.api.royco.org/api/v1";

function headers(): Record<string, string> {
  return env.ROYCO_API_KEY ? { "x-api-key": env.ROYCO_API_KEY } : {};
}

// Normalised into the same `{ timestamp(ms), apy(percent) }` shape DeFiLlama returns.
export interface RoycoHistoryPoint {
  timestamp: number;
  apy: number;
}

export async function fetchRoycoVaultApyHistory(
  vaultAddress: string,
  chainId = 1,
  duration = "3m",
): Promise<RoycoHistoryPoint[]> {
  // The chart endpoint is case-sensitive and 500s on a checksummed address — lowercase only.
  const address = vaultAddress.toLowerCase();
  const data = await getJson<{ data?: Array<{ blockTimestamp?: number; value?: number | string }> }>(
    `${ROYCO_BASE}/chart/vault/apy/${chainId}/${address}/${duration}`,
    { source: "royco", headers: headers(), retries: 2 },
  );
  // Royco returns a fixed-length window padded with value:0 before the vault existed. Drop that
  // leading pre-inception run so it can't drag down the trailing averages. value is a decimal
  // fraction (0.037 = 3.7%); blockTimestamp is in seconds.
  const rows = data?.data ?? [];
  const firstLive = rows.findIndex((row) => Number(row?.value) > 0);
  return (firstLive === -1 ? [] : rows.slice(firstLive)).map((row) => ({
    timestamp: (row.blockTimestamp ?? 0) * 1000,
    apy: Number(row.value) * 100,
  }));
}

// Headline APY: 7d window, matching the avg7d convention used for StableWatch stables.
export async function fetchRoycoVaultApy(vaultAddress: string, chainId = 1): Promise<string> {
  const address = vaultAddress.toLowerCase();
  const data = await getJson<{ apy7d?: number | string }>(
    `${ROYCO_BASE}/vault/info/${chainId}/${address}`,
    { source: "royco", headers: headers(), retries: 2 },
  );
  return BigNumber((Number(data?.apy7d) || 0) * 100).toFixed(2);
}
