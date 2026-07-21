// Morpho GraphQL — borrow APY, liquidity, supply, public-allocator shared depth, and borrow-APY
// history. Ported from api-services/morpho.ts (parse logic identical for parity). Caching is the
// warmer's job here; these are pure fetch+parse functions.
import BigNumber from "bignumber.js";
import { Market, MarketCurator, SharedLiquidityRaw } from "../types/index.ts";
import { formatUnits } from "../core/formatUnits.ts";
import { postJson } from "./http.ts";

const MORPHO_URL = "https://api.morpho.org/graphql";

const MORPHO_FIELDS = `
  state {
    borrowApy
    avgBorrowApy
    quarterlyBorrowApy
    liquidityAssets
    liquidityAssetsUsd
    supplyAssets
    supplyAssetsUsd
  }
  publicAllocatorSharedLiquidity {
    assets
    vault {
      address
      name
      publicAllocatorConfig {
        fee
      }
    }
    withdrawMarket {
      marketId
    }
  }
  supplyingVaultV2s {
    name
    totalAssetsUsd
    curators {
      items {
        name
        image
      }
    }
  }
`;

// Dedupe the curators across a market's supplying V2 vaults, keep the top 2 by their largest
// supplying vault's TVL (mega-vaults like Steakhouse/Gauntlet supply nearly every market, so
// ranking keeps the most material curators first), and list each curator's vaults largest-first.
const parseCurators = (supplyingVaultV2s: any[]): MarketCurator[] => {
  const byName = new Map<string, MarketCurator & { maxUsd: number }>();
  for (const vault of supplyingVaultV2s ?? []) {
    const totalAssetsUsd = Number(vault.totalAssetsUsd) || 0;
    for (const c of vault.curators?.items ?? []) {
      if (!c?.name) continue;
      const entry: MarketCurator & { maxUsd: number } =
        byName.get(c.name) ?? { name: c.name, image: c.image ?? "", vaults: [], maxUsd: 0 };
      if (!entry.image && c.image) entry.image = c.image;
      entry.vaults.push({ name: vault.name, totalAssetsUsd });
      entry.maxUsd = Math.max(entry.maxUsd, totalAssetsUsd);
      byName.set(c.name, entry);
    }
  }

  return [...byName.values()]
    .sort((a, b) => b.maxUsd - a.maxUsd)
    .slice(0, 2)
    .map(({ maxUsd: _maxUsd, ...c }) => ({
      ...c,
      vaults: c.vaults.sort((a, b) => b.totalAssetsUsd - a.totalAssetsUsd),
    }));
};

export interface MorphoMarketData {
  borrowApy: string;
  quarterlyBorrowApy: string;
  supplyAssets: BigNumber;
  supplyAssetsUsd: number;
  liquidityAssetsParsed: bigint;
  liquidityAssets: BigNumber;
  liquidityAssetsUsd: number;
  paLiquidityAssets: BigNumber;
  paSharedLiquidity: SharedLiquidityRaw[];
  curators?: MarketCurator[];
}

const parseMorphoMarketData = (raw: any, market: Market): MorphoMarketData => {
  // Keep raw asset values as BigInt throughout to avoid Number precision loss for 18-decimal
  // loan tokens (e.g. WETH) where values exceed MAX_SAFE_INTEGER.
  const supplyAssetsBigInt = BigInt(raw.state.supplyAssets);
  const supplyAssetsUsd = Number(raw.state.supplyAssetsUsd);
  const liquidityAssetsBigInt = BigInt(raw.state.liquidityAssets);
  const liquidityAssetsUsd = Number(raw.state.liquidityAssetsUsd);

  let paLiquidityAssets = liquidityAssetsBigInt;
  raw.publicAllocatorSharedLiquidity.forEach((pa: any) => {
    paLiquidityAssets += BigInt(pa.assets);
  });

  const borrowApy = Math.min(raw.state.avgBorrowApy, raw.state.borrowApy);
  const quarterlyBorrowApy = raw.state.quarterlyBorrowApy ?? borrowApy;

  return {
    borrowApy: BigNumber(borrowApy * 100).toFixed(2),
    quarterlyBorrowApy: BigNumber(quarterlyBorrowApy * 100).toFixed(2),
    supplyAssets: formatUnits(supplyAssetsBigInt, market.loanToken.decimals),
    supplyAssetsUsd,
    liquidityAssetsParsed: liquidityAssetsBigInt,
    liquidityAssets: formatUnits(liquidityAssetsBigInt, market.loanToken.decimals),
    liquidityAssetsUsd,
    paLiquidityAssets: formatUnits(paLiquidityAssets, market.loanToken.decimals),
    paSharedLiquidity: raw.publicAllocatorSharedLiquidity as SharedLiquidityRaw[],
    curators: parseCurators(raw.supplyingVaultV2s),
  };
};

const CHUNK_SIZE = 30;

const fetchMorphoChunk = async (chainId: number, chunk: Market[]): Promise<any> => {
  const varDefs = chunk.map((_, i) => `$id${i}: String!`).join(", ");
  const variables: Record<string, string | number> = { chainId };
  chunk.forEach((m, i) => {
    variables[`id${i}`] = m.morphoMarketId;
  });

  const query = `
    query Chunk($chainId: Int!, ${varDefs}) {
      ${chunk
        .map(
          (_, i) => `
        m${i}: marketById(marketId: $id${i}, chainId: $chainId) {
          ${MORPHO_FIELDS}
        }`,
        )
        .join("")}
    }
  `;

  const res = await postJson<{ data: any }>(MORPHO_URL, { query, variables }, { source: "morpho", retries: 2 });
  return res.data;
};

export const fetchAllMorphoMarketsData = async (
  chainId: number,
  markets: Market[],
): Promise<Record<string, MorphoMarketData>> => {
  if (chainId === 31337) chainId = 1;

  const chunks: Market[][] = [];
  for (let i = 0; i < markets.length; i += CHUNK_SIZE) {
    chunks.push(markets.slice(i, i + CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(chunks.map((chunk) => fetchMorphoChunk(chainId, chunk)));

  const result: Record<string, MorphoMarketData> = {};
  markets.forEach((market, i) => {
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const localIndex = i % CHUNK_SIZE;
    result[market.morphoMarketId] = parseMorphoMarketData(
      chunkResults[chunkIndex][`m${localIndex}`],
      market,
    );
  });

  return result;
};

// ── Borrow-APY history (charts + 30/60/90d windows) ──────────────────────────
export interface BorrowHistoryPoint {
  x: number; // unix seconds
  y: number; // fraction (×100 → %)
}

const HISTORY_CHUNK_SIZE = 10;

const parseBorrowHistory = (raw: BorrowHistoryPoint[]): BorrowHistoryPoint[] => {
  const ninetyDaysAgo = Date.now() / 1000 - 90 * 24 * 3600;
  return raw.filter((p) => p.x >= ninetyDaysAgo).sort((a, b) => a.x - b.x);
};

const fetchBorrowHistoryChunk = async (
  chainId: number,
  marketIds: string[],
): Promise<Record<string, BorrowHistoryPoint[]>> => {
  const varDefs = marketIds.map((_, i) => `$id${i}: String!`).join(", ");
  const variables: Record<string, string | number> = { chainId };
  marketIds.forEach((id, i) => {
    variables[`id${i}`] = id;
  });

  const query = `
    query BorrowHistoryChunk($chainId: Int!, ${varDefs}) {
      ${marketIds
        .map(
          (_, i) => `
        m${i}: marketById(marketId: $id${i}, chainId: $chainId) {
          historicalState { borrowApy { x y } }
        }`,
        )
        .join("")}
    }
  `;

  const res = await postJson<{ data: any }>(MORPHO_URL, { query, variables }, { source: "morpho", retries: 2 });
  const data = res.data;
  const result: Record<string, BorrowHistoryPoint[]> = {};
  marketIds.forEach((id, i) => {
    result[id] = parseBorrowHistory(data[`m${i}`]?.historicalState?.borrowApy ?? []);
  });
  return result;
};

export const fetchAllBorrowApyHistories = async (
  chainId: number,
  markets: Market[],
): Promise<Record<string, BorrowHistoryPoint[]>> => {
  if (chainId === 31337) chainId = 1;

  const ids = markets.map((m) => m.morphoMarketId);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += HISTORY_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + HISTORY_CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchBorrowHistoryChunk(chainId, chunk).catch(() => ({}) as Record<string, BorrowHistoryPoint[]>),
    ),
  );

  const result: Record<string, BorrowHistoryPoint[]> = {};
  for (const chunkResult of chunkResults) {
    for (const [marketId, history] of Object.entries(chunkResult)) {
      result[marketId] = history;
    }
  }
  return result;
};
