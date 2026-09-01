// Equity vaults — live data for the EXTERNAL stock markets that back the synthetic equity strategies.
// Borrow APR + liquidity come from Morpho's GraphQL (same source/parse as sources/morpho.ts); the
// live stock price comes from the market's Chainlink oracle via viem. Warmed under KEYS.equityMarkets
// (see cache/policy.ts) and composed into strategies by core/equity.ts — never fetched inline.
import BigNumber from "bignumber.js";
import { postJson } from "./http.ts";
import { getClient } from "./onchain.ts";
import { equityVaultsFor } from "../data/equityVaults.ts";

const MORPHO_URL = "https://api.morpho.org/graphql";

const ORACLE_ABI = [
  { name: "price", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface EquityMarketRaw {
  /** Stock-market USDG borrow APR (%). This is the number that makes netApy negative when the market is near-maxed. */
  borrowApyPct: string;
  /** USDG available to borrow ($) — the vault's scaling ceiling. */
  liquidityUsd: number;
  /** USDG available to borrow (raw loan-token units, as a string to stay JSON/bigint-safe). */
  liquidityAssetsParsed: string;
  supplyUsd: number;
  /** Live stock price in USD (from the market's oracle). */
  stockPriceUsd: number;
}

/** Keyed by stockMarketId. Empty when the chain has no equity vaults configured. */
export async function fetchEquityMarketsData(chainId: number): Promise<Record<string, EquityMarketRaw>> {
  const vaults = equityVaultsFor(chainId);
  if (vaults.length === 0) return {};

  const varDefs = vaults.map((_, i) => `$id${i}: String!`).join(", ");
  const variables: Record<string, string | number> = { chainId };
  vaults.forEach((v, i) => {
    variables[`id${i}`] = v.stockMarketId;
  });
  const query = `
    query Equity($chainId: Int!, ${varDefs}) {
      ${vaults
        .map(
          (_, i) => `m${i}: marketById(marketId: $id${i}, chainId: $chainId) {
        state { borrowApy avgBorrowApy liquidityAssets liquidityAssetsUsd supplyAssetsUsd }
      }`,
        )
        .join("\n")}
    }`;
  const res = await postJson<{ data: Record<string, { state: Record<string, number | string> }> }>(
    MORPHO_URL,
    { query, variables },
    { source: "equity-morpho", retries: 2 },
  );

  const client = getClient(chainId);
  const out: Record<string, EquityMarketRaw> = {};
  await Promise.all(
    vaults.map(async (v, i) => {
      const st = res.data[`m${i}`].state;
      // Match sources/morpho.ts: the conservative of spot vs 24h-avg borrow APY.
      const borrowApy = Math.min(Number(st.avgBorrowApy), Number(st.borrowApy));
      const price = (await client.readContract({
        address: v.stock.oracle as `0x${string}`,
        abi: ORACLE_ABI,
        functionName: "price",
      })) as bigint;
      // Morpho oracle price is scaled by 1e(36 + loanDecimals - collateralDecimals); loan token (USDG) ~ $1.
      const scale = BigNumber(10).pow(36 + v.loanToken.decimals - v.stock.decimals);
      const stockPriceUsd = BigNumber(price.toString()).div(scale).toNumber();
      out[v.stockMarketId] = {
        borrowApyPct: BigNumber(borrowApy * 100).toFixed(2),
        liquidityUsd: Number(st.liquidityAssetsUsd),
        liquidityAssetsParsed: BigInt(st.liquidityAssets as string).toString(),
        supplyUsd: Number(st.supplyAssetsUsd),
        stockPriceUsd,
      };
    }),
  );
  return out;
}
