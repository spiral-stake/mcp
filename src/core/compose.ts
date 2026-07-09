// Market assembly — the server-side port of FlashLeverage.createInstance's market-mapping.
// Composes the full internal Market[] from WARM RAW only (never fetches). Every numeric step
// mirrors the app so the downstream contract + app-surface endpoints match like-for-like.
import BigNumber from "bignumber.js";
import { Market } from "../types/index.ts";
import { formatUnits } from "./formatUnits.ts";
import { calcLeverage, calcLeverageApy } from "./leverage.ts";
import { resolveTokenApy, resolveTokenApyHistory, type ApyHistoryPoint, type ApySource } from "./apy.ts";
import { avgCollateralApyOverDays, computeAvgLeverageApy } from "./leverageApy.ts";
import { readMarkets } from "../data/markets.ts";
import { rawStore, type FreshView } from "../cache/store.ts";
import { KEYS } from "../cache/policy.ts";
import { isStUSDS, isSpUSDG } from "../sources/onchain.ts";
import type { MorphoMarketData, BorrowHistoryPoint } from "../sources/morpho.ts";
import type { ApySnapshot } from "../sources/stablewatch.ts";
import type { PendleMarket } from "../sources/pendle.ts";
import type { DefillamaPoint } from "../sources/defillama.ts";
import type { MerklIncentiveData } from "../sources/merkl.ts";

export interface ComposedMarket {
  market: Market;
  apySource: ApySource;
  apyHistory: ApyHistoryPoint[];
  borrowHistory: BorrowHistoryPoint[];
}

export interface ComposedSnapshot {
  chainId: number;
  asOf: string;
  markets: ComposedMarket[];
  /** Raw-store freshness views by cache key, for building the contract's per-group freshness. */
  views: Record<string, FreshView<unknown> | undefined>;
}

export function composeSnapshot(chainId: number): ComposedSnapshot {
  const markets = readMarkets(chainId);

  // ── read warm raw (last-good) ──
  const vMorpho = rawStore.view<Record<string, MorphoMarketData>>(KEYS.morphoMarkets(chainId));
  const vColl = rawStore.view<Record<string, BigNumber>>(KEYS.onchainCollateralValue(chainId));
  const vPrices = rawStore.view<Record<string, BigNumber>>(KEYS.prices(chainId));
  const vSnapshot = rawStore.view<ApySnapshot>(KEYS.stablewatchApy());
  const vPendle = rawStore.view<PendleMarket[]>(KEYS.pendle());
  const vDefillama = rawStore.view<Record<string, DefillamaPoint[]>>(KEYS.defillamaAll(chainId));
  const vRoyco = rawStore.view<Record<string, { apy: string; history: ApyHistoryPoint[] }>>(KEYS.roycoAll(chainId));
  const vStUSDS = rawStore.view<string>(KEYS.onchainStUSDS());
  const vSpUSDG = rawStore.view<string>(KEYS.onchainSpUSDG());
  const vMerkl = rawStore.view<MerklIncentiveData>(KEYS.merkl(chainId));
  const vBorrowHist = rawStore.view<Record<string, BorrowHistoryPoint[]>>(KEYS.morphoBorrowHistory(chainId));

  const morphoData = vMorpho?.value ?? {};
  const collateralValues = vColl?.value ?? {};
  const prices = vPrices?.value ?? {};
  const snapshot = vSnapshot?.value;
  const stableApyData = snapshot?.stableApy ?? [];
  const ptApyData = vPendle?.value ?? [];
  const allDefillamaApy = vDefillama?.value ?? {};
  const allRoyco = vRoyco?.value ?? {};
  const stUSDSApy = vStUSDS?.value;
  const spUSDGApy = vSpUSDG?.value;
  const merkl = vMerkl?.value ?? { spot: {}, histories: {} };
  const borrowHistories = vBorrowHist?.value ?? {};

  const priceOf = (address: string): BigNumber => {
    const raw = prices[address];
    return raw instanceof BigNumber ? raw : raw != null ? new BigNumber(raw as any) : new BigNumber(1);
  };

  const composed: ComposedMarket[] = [];

  for (const base of markets) {
    const market = base;
    market.marketParams = {
      collateralToken: market.collateralToken.address,
      loanToken: market.loanToken.address,
      oracle: market.oracle,
      irm: market.irm,
      lltv: BigInt(market.liqLtv as unknown as number),
    };

    // Oracle read (collateralTokenValueInLoanToken). Missing → drop market (app parity: the app
    // drops a market whose oracle read failed).
    const cvRaw = collateralValues[market.morphoMarketId];
    if (cvRaw == null) continue;
    const collateralTokenValueInLoanToken =
      cvRaw instanceof BigNumber ? cvRaw : new BigNumber(cvRaw as any);

    const liqLtv = formatUnits(BigInt(market.liqLtv as unknown as number), 16);
    const maxLtv = formatUnits(BigInt(market.maxLtv as unknown as number), 16);
    const safeLtv = maxLtv.minus(0.75).toFixed(2);

    market.collateralTokenValueInLoanToken = collateralTokenValueInLoanToken;
    market.loanTokenValueInCollateralToken = new BigNumber(1).div(collateralTokenValueInLoanToken);
    market.liqLtv = liqLtv.toFixed(2);
    market.maxLtv = maxLtv.toFixed(2);
    market.safeLtv = safeLtv;
    market.defaultLeverage = calcLeverage(safeLtv);

    // ── collateral APY (spot) + history ──
    const { apy: spotTokenApy, source: apySource } = resolveTokenApy(
      market.collateralToken,
      stableApyData,
      ptApyData,
      allDefillamaApy,
      chainId,
      stUSDSApy,
      spUSDGApy,
      allRoyco,
    );
    const apyHistory = resolveTokenApyHistory(market.collateralToken, snapshot, allDefillamaApy, allRoyco);

    const apyDayWindow = market.collateralToken.info?.defaultLeverageApyDay;
    const tokenApy = apyDayWindow
      ? avgCollateralApyOverDays(apyHistory, apyDayWindow, spotTokenApy)
      : spotTokenApy;

    const loanTokenValueInUsd = priceOf(market.loanToken.address);

    // ── borrow data (Morpho) ──
    const morphoMarketData = morphoData[market.morphoMarketId];
    if (!morphoMarketData) continue; // no borrow data warm yet — skip (readiness gates this)

    // ── borrow incentives (Merkl spot + history) ──
    const marketKey = market.morphoMarketId.toLowerCase();
    const spot = merkl.spot[marketKey];
    const borrowIncentiveApy = spot?.apy ?? "0.00";
    const borrowIncentiveBreakdown = spot?.breakdown ?? [];
    const borrowIncentiveUrl = spot?.url || undefined;
    const borrowIncentiveHistory = merkl.histories[marketKey] ?? [];

    const liquidityAssetsUsd =
      morphoMarketData.liquidityAssetsUsd ||
      morphoMarketData.liquidityAssets.multipliedBy(loanTokenValueInUsd).toNumber();
    const supplyAssetsUsd =
      morphoMarketData.supplyAssetsUsd ||
      morphoMarketData.supplyAssets.multipliedBy(loanTokenValueInUsd).toNumber();

    Object.assign(market, morphoMarketData, {
      borrowIncentiveApy,
      borrowIncentiveBreakdown,
      borrowIncentiveUrl,
      borrowIncentiveHistory,
      liquidityAssetsUsd,
      supplyAssetsUsd,
    });

    market.collateralToken = {
      ...market.collateralToken,
      apy: tokenApy,
      valueInUsd: collateralTokenValueInLoanToken.multipliedBy(loanTokenValueInUsd),
      ...(market.collateralToken.underlying && {
        underlying: {
          ...market.collateralToken.underlying,
          valueInUsd: priceOf(market.collateralToken.underlying.address),
        },
      }),
    };
    market.loanToken = { ...market.loanToken, valueInUsd: loanTokenValueInUsd };

    market.defaultLeverageApy = calcLeverageApy(
      market.correlated,
      tokenApy,
      BigNumber(morphoMarketData.borrowApy).minus(borrowIncentiveApy).toFixed(2),
      market.safeLtv,
    );

    const borrowHistory = borrowHistories[market.morphoMarketId] ?? [];
    market.avg30dLeverageApy = computeAvgLeverageApy(apyHistory, borrowHistory, borrowIncentiveHistory, 30, market);
    market.avg60dLeverageApy = computeAvgLeverageApy(apyHistory, borrowHistory, borrowIncentiveHistory, 60, market);
    market.avg90dLeverageApy = computeAvgLeverageApy(apyHistory, borrowHistory, borrowIncentiveHistory, 90, market);

    composed.push({ market, apySource, apyHistory, borrowHistory });
  }

  const views: Record<string, FreshView<unknown> | undefined> = {
    [KEYS.morphoMarkets(chainId)]: vMorpho,
    [KEYS.onchainCollateralValue(chainId)]: vColl,
    [KEYS.prices(chainId)]: vPrices,
    [KEYS.stablewatchApy()]: vSnapshot,
    [KEYS.pendle()]: vPendle,
    [KEYS.defillamaAll(chainId)]: vDefillama,
    [KEYS.roycoAll(chainId)]: vRoyco,
    [KEYS.onchainStUSDS()]: vStUSDS,
    [KEYS.onchainSpUSDG()]: vSpUSDG,
    [KEYS.merkl(chainId)]: vMerkl,
    [KEYS.morphoBorrowHistory(chainId)]: vBorrowHist,
  };

  return { chainId, asOf: new Date().toISOString(), markets: composed, views };
}

// Helper: which store key backs a market's collateral-APY source (for freshness attribution).
export function apySourceKey(chainId: number, source: ApySource, collateralAddress: string): string | undefined {
  switch (source) {
    case "pendle":
      return KEYS.pendle();
    case "defillama":
      return KEYS.defillamaAll(chainId);
    case "royco":
      return KEYS.roycoAll(chainId);
    case "stablewatch":
      return KEYS.stablewatchApy();
    case "onchain":
      return isStUSDS(collateralAddress)
        ? KEYS.onchainStUSDS()
        : isSpUSDG(collateralAddress)
          ? KEYS.onchainSpUSDG()
          : undefined;
    default:
      return undefined;
  }
}
