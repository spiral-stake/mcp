// Collateral-token APY resolution — ported from api-services/apy.ts (resolveTokenApy /
// resolveTokenApyHistory). Pure functions over already-fetched raw inputs (the app fetched
// these inline; here the warmer supplies them from the cache). Logic is kept identical for
// parity — same source precedence, same rounding, same 0.00 fallback.
import BigNumber from "bignumber.js";
import { CollateralToken, TokenCategory } from "../types/index.ts";
import { isStUSDS, isSpUSDG } from "../sources/onchain.ts";

export type ApyHistoryPoint = { ts: number; apy: number };

// Which upstream produced the resolved APY — surfaced in the contract as `collateralApySource`.
export type ApySource = "pendle" | "defillama" | "royco" | "stablewatch" | "onchain" | "none";

export interface ResolvedApy {
  apy: string;
  source: ApySource;
}

export function resolveTokenApy(
  collateralToken: CollateralToken,
  allStableApy: any[],
  allPtApy: any[],
  allDefillamaApy: Record<string, any[]>,
  chainId: number,
  stUSDSApy?: string,
  spUSDGApy?: string,
  allRoyco: Record<string, { apy: string; history: any[] }> = {},
): ResolvedApy {
  try {
    if (isStUSDS(collateralToken.address) && stUSDSApy) {
      return { apy: stUSDSApy, source: "onchain" };
    }
    if (isSpUSDG(collateralToken.address)) {
      const defillamaData = collateralToken.info.defillamaId ? allDefillamaApy[collateralToken.info.defillamaId] : null;
      if (defillamaData?.length)
        return { apy: BigNumber(defillamaData[defillamaData.length - 1].apy).toFixed(2), source: "defillama" };
      if (spUSDGApy) return { apy: spUSDGApy, source: "onchain" };
    }

    if (collateralToken.info.royco) {
      return {
        apy: allRoyco[collateralToken.address.toLowerCase()]?.apy ?? BigNumber(0).toFixed(2),
        source: "royco",
      };
    }

    if (collateralToken.isPt && chainId === 1) {
      const tokenInfo = allPtApy.find(
        (t: any) => t.pt === `1-${collateralToken.address.toLowerCase()}`,
      );
      return {
        apy: BigNumber(tokenInfo ? tokenInfo.details.impliedApy * 100 : 0).toFixed(2),
        source: "pendle",
      };
    }

    if (collateralToken.info.category === TokenCategory.Stable) {
      const { stablewatchId, defillamaId } = collateralToken.info;
      if (!stablewatchId && defillamaId) {
        const defillamaData = allDefillamaApy[defillamaId];
        if (defillamaData?.length)
          return {
            apy: BigNumber(defillamaData[defillamaData.length - 1].apy).toFixed(2),
            source: "defillama",
          };
      } else {
        const tokenInfo = stablewatchId
          ? allStableApy.find((s: any) => s.id?.toLowerCase() === stablewatchId.toLowerCase())
          : allStableApy.find((s: any) => s.asset === collateralToken.symbol);
        if (tokenInfo) return { apy: BigNumber(tokenInfo.metrics.apy.avg7d).toFixed(2), source: "stablewatch" };
        if (defillamaId) {
          const defillamaData = allDefillamaApy[defillamaId];
          if (defillamaData?.length)
            return {
              apy: BigNumber(defillamaData[defillamaData.length - 1].apy).toFixed(2),
              source: "defillama",
            };
        }
      }
    }

    const isStable = collateralToken.info.category === TokenCategory.Stable;
    if (!isStable && collateralToken.info.defillamaId) {
      const tokenInfo = allDefillamaApy[collateralToken.info.defillamaId];
      return { apy: BigNumber(tokenInfo[tokenInfo.length - 1].apy).toFixed(2), source: "defillama" };
    }
  } catch {
    // APY drives the user's core decision — mirror the app's behaviour: fall through to 0.00.
  }
  return { apy: BigNumber(0).toFixed(2), source: "none" };
}

export function resolveTokenApyHistory(
  collateralToken: CollateralToken,
  snapshot: any,
  allDefillamaApy: Record<string, any[]>,
  allRoyco: Record<string, { apy: string; history: any[] }> = {},
): ApyHistoryPoint[] {
  try {
    const { stablewatchId, defillamaId, category, royco } = collateralToken.info;
    // (category kept for parity with the app's isStable computation, though unused downstream.)
    void (category === TokenCategory.Stable || category === TokenCategory.StablePT);

    const normalize = (arr: any[]): ApyHistoryPoint[] =>
      arr
        .map((row: any) => ({ ts: new Date(row.timestamp ?? NaN).getTime(), apy: Number(row.apy) }))
        .filter((r) => isFinite(r.apy) && !isNaN(r.ts));

    if (royco) {
      return normalize(allRoyco[collateralToken.address.toLowerCase()]?.history ?? []);
    }
    if (stablewatchId) {
      const pool = snapshot?.stableApy?.find(
        (p: any) => p.id?.toLowerCase() === stablewatchId.toLowerCase(),
      );
      return normalize(pool?.history ?? []);
    }
    if (defillamaId) {
      return normalize(allDefillamaApy[defillamaId] ?? []);
    }
  } catch {
    // fall through
  }
  return [];
}
