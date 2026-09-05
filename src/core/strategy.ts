// Market -> frozen `/strategies` contract (v1). Maps the internal Market model to the external
// wire shape in types/contract.ts, exactly per CONTRACT.md: raw facts only, `null`-vs-absent
// preserved, the single verdict (exitLiquidityTier) isolated in `spiralHints` with its
// thresholds, and per-field-group freshness. The leverage ladder + all APYs use the copied
// leverage.ts, locking them to the app.
import BigNumber from "bignumber.js";
import { Market, CollateralTokenInfo } from "../types/index.ts";
import { calcLeverage, calcLeverageApy } from "./leverage.ts";
import {
  exitLiquidityTier,
  LISTING_MAX_SLIPPAGE,
  DEPTH_MAX_SLIPPAGE,
} from "./exitLiquidity.ts";
import { avgCollateralApyOverDays } from "./leverageApy.ts";
import { collateralTokensAsOf } from "../data/markets.ts";
import { KEYS, EXIT_LIQUIDITY_STALE_AFTER_SEC } from "../cache/policy.ts";
import type { FreshView } from "../cache/store.ts";
import type {
  Strategy,
  LadderPoint,
  ExitLiquidity,
  FreshnessGroup,
  StrategiesEnvelope,
} from "../types/contract.ts";
import { composeSnapshot, apySourceKey, type ComposedMarket, type ComposedSnapshot } from "./compose.ts";

const APP_BASE = "https://app.spiralstake.xyz";

// Tori Finance "cores" — an off-chain points program on strUSD collateral. Pure rate only (5/day per
// token, in Tori's terms); the live accrued total per position is portfolio-level and Tori's /points
// endpoint is IP-rate-limited, so it stays client-side. Cores accrue to the position's proxy on the
// LEVERAGED balance, so effective = 5 x leverage x tokens deposited. Mirrors the app's tori.ts.
const TORI_CORES_PER_TOKEN = 5;
const TORI_COLLATERAL = new Set(["0x280839980a7ed0d7717f64125fe241012e5f5815"]); // strUSD, mainnet
const isToriCollateral = (address: string): boolean => TORI_COLLATERAL.has(address.toLowerCase());

// ── ladder ────────────────────────────────────────────────────────────────────
// Integer leverage steps 1x, 2x, … up to floor(maxLeverage), then always append the exact max.
// Each step's LTV = (1 - 1/lev)·100; its APY uses the same leverage.ts the app runs live.
function buildLadder(market: Market): { ladder: LadderPoint[]; maxLeverage: string; defaultPoint: LadderPoint } {
  // Effective collateral yield = base APY + collateral-side incentive (matches compose's sizing).
  const collateralApy = BigNumber(market.collateralToken.apy).plus(market.collateralIncentiveApy).toFixed(2);
  const netBorrow = BigNumber(market.borrowApy).minus(market.borrowIncentiveApy).toFixed(2);
  const maxLtv = Number(market.maxLtv);
  const maxLeverage = calcLeverage(market.maxLtv); // = calcLeverage(maxLtv)
  const maxLeverageNum = Number(maxLeverage);

  // Honest carry: collateral yield − borrow cost, × leverage, WITHOUT the client's uncorrelated
  // sign-flip (calcLeverageApy flips longs to a positive pseudo-yield for a "Borrow APY" label the
  // app shows; agents get the raw signed carry instead — negative for a directional perp). Passing
  // correlated=true forces the un-flipped value for both profiles.
  const honestLeverageApy = (ltv: string) => calcLeverageApy(true, collateralApy, netBorrow, ltv);

  const point = (leverageNum: number, ltvPctNum: number): LadderPoint => {
    const ltv = ltvPctNum.toFixed(2);
    return {
      leverage: BigNumber(leverageNum).toFixed(1),
      ltvPct: BigNumber(ltvPctNum).toFixed(1),
      leverageApyPct: honestLeverageApy(ltv),
    };
  };

  const ladder: LadderPoint[] = [];
  const lastInteger = Math.max(1, Math.floor(maxLeverageNum));
  for (let lev = 1; lev <= lastInteger; lev++) {
    // ltv for an integer leverage: lev = 1/(1-ltv) -> ltv = (1 - 1/lev)·100
    const ltvPct = lev === 1 ? 0 : (1 - 1 / lev) * 100;
    ladder.push(point(lev, ltvPct));
  }
  // Always append the exact max (unless an integer step already lands exactly on it).
  const maxPoint: LadderPoint = {
    leverage: maxLeverage,
    ltvPct: BigNumber(maxLtv).toFixed(1),
    leverageApyPct: honestLeverageApy(market.maxLtv),
  };
  if (ladder[ladder.length - 1]?.leverage !== maxPoint.leverage) ladder.push(maxPoint);

  // Default leverage sits at the app's safeLtv (maxLtv - 0.75). Recomputed honestly (not
  // market.defaultLeverageApy, which carries the app's uncorrelated sign-flip).
  const defaultPoint: LadderPoint = {
    leverage: market.defaultLeverage,
    ltvPct: BigNumber(market.safeLtv).toFixed(1),
    leverageApyPct: honestLeverageApy(market.safeLtv),
  };

  return { ladder, maxLeverage, defaultPoint };
}

// ── exit liquidity (raw facts) + spiralHints (the only verdict) ────────────────
const EXIT_SIZES: [keyof Pick<CollateralTokenInfo, "exitSlippage100k" | "exitSlippage500k" | "exitSlippage1M" | "exitSlippage5M" | "exitSlippage10M">, string][] = [
  ["exitSlippage100k", "100000"],
  ["exitSlippage500k", "500000"],
  ["exitSlippage1M", "1000000"],
  ["exitSlippage5M", "5000000"],
  ["exitSlippage10M", "10000000"],
];

function buildExitLiquidity(info: CollateralTokenInfo | undefined): ExitLiquidity {
  if (!info || info.exitSlippage100k === undefined) {
    return { measured: false };
  }
  const slippagePct: Record<string, string | null> = {};
  for (const [field, sizeKey] of EXIT_SIZES) {
    const v = info[field];
    if (v === undefined) continue; // ABSENT = unmeasured (do not emit key)
    slippagePct[sizeKey] = v === null ? null : BigNumber(v).toFixed(2); // null = no route (preserved)
  }
  return {
    measured: true,
    asOf: collateralTokensAsOf,
    method: "onchain quote sweep",
    direction: "collateral_to_usdc",
    slippagePct,
  };
}

// ── freshness ──────────────────────────────────────────────────────────────────
function freshnessFromView(view: FreshView<unknown> | undefined): FreshnessGroup | undefined {
  if (!view) return undefined;
  const group: FreshnessGroup = { asOf: view.asOf, staleAfterSec: view.staleAfterSec };
  if (view.staleForSec > 0) group.staleForSec = view.staleForSec;
  return group;
}

export function toStrategy(cm: ComposedMarket, snapshot: ComposedSnapshot): Strategy {
  const { market, apySource } = cm;
  const chainId = snapshot.chainId;
  const info = market.collateralToken.info;

  const { ladder, maxLeverage, defaultPoint } = buildLadder(market);
  const netBorrowApyPct = BigNumber(market.borrowApy).minus(market.borrowIncentiveApy).toFixed(2);

  // Yield sustainability = trailing collateral-APY averages (facts about the collateral yield).
  const yieldSustainabilityPct = {
    avg30d: avgCollateralApyOverDays(cm.apyHistory, 30, market.collateralToken.apy),
    avg60d: avgCollateralApyOverDays(cm.apyHistory, 60, market.collateralToken.apy),
    avg90d: avgCollateralApyOverDays(cm.apyHistory, 90, market.collateralToken.apy),
  };

  // Utilisation = borrowed / supply (borrowed = supply - available liquidity). Absent if supply 0.
  const supplyUsd = market.supplyAssetsUsd;
  const liquidityUsd = market.liquidityAssetsUsd;
  const borrowedAssets = market.supplyAssets.minus(market.liquidityAssets);
  const utilizationPct =
    market.supplyAssets.isZero() || market.supplyAssets.isNegative()
      ? undefined
      : borrowedAssets.div(market.supplyAssets).multipliedBy(100).toFixed(2);

  const publicAllocatorLiquidityUsd = market.paLiquidityAssets
    .multipliedBy(market.loanToken.valueInUsd)
    .toNumber();

  // Historical leverage APYs come pre-flipped for longs (computed via the app's calcLeverageApy);
  // un-flip them so the agent's historical series carries the same honest sign as the ladder.
  const honestHistorical = (v: string | undefined): string | undefined =>
    v === undefined ? undefined : market.correlated ? v : BigNumber(v).multipliedBy(-1).toFixed(2);

  // exit liquidity + the Spiral opinion block (isolated, with thresholds). Two overridable hints:
  // the exit-liquidity tier, and — for uncorrelated markets — how to read the (carry-only) APYs.
  const exitLiquidity = buildExitLiquidity(info);
  const tier = exitLiquidityTier(info);
  const spiralHints =
    tier === "unknown" && market.correlated
      ? undefined
      : {
          ...(tier !== "unknown"
            ? {
                exitLiquidityTier: {
                  value: tier,
                  thresholds: { listingMaxPct: LISTING_MAX_SLIPPAGE, depthCleanMaxPct: DEPTH_MAX_SLIPPAGE },
                },
              }
            : {}),
          ...(!market.correlated
            ? {
                profile: {
                  value: "leveraged_perp",
                  leverageApyMeaning:
                    "Directional perp. Every leverageApyPct here is the annualized FINANCING CARRY only " +
                    "(collateralApyPct − netBorrowApyPct, scaled by leverage) and is typically negative; it " +
                    "excludes the collateral's price change, which dominates P&L. Liquidates if the collateral " +
                    "falls to ltvPct.liquidation.",
                },
              }
            : {}),
        };

  // borrow incentive block — omit entirely when there is none (absent, not zero-noise).
  const borrowIncentive =
    Number(market.borrowIncentiveApy) > 0
      ? {
          aprPct: market.borrowIncentiveApy,
          breakdown: market.borrowIncentiveBreakdown.map((b) => ({ symbol: b.symbol, aprPct: b.apy })),
          ...(market.borrowIncentiveUrl ? { campaignUrl: market.borrowIncentiveUrl } : {}),
        }
      : undefined;

  // collateral incentive block (MORPHOCOLLATERAL) — extra yield on the collateral; already folded
  // into the leverageLadder APYs. Same shape as borrowIncentive; omitted when there is none.
  const collateralIncentive =
    Number(market.collateralIncentiveApy) > 0
      ? {
          aprPct: market.collateralIncentiveApy,
          breakdown: market.collateralIncentiveBreakdown.map((b) => ({ symbol: b.symbol, aprPct: b.apy })),
          ...(market.collateralIncentiveUrl ? { campaignUrl: market.collateralIncentiveUrl } : {}),
        }
      : undefined;

  // freshness attribution
  const borrowFresh = freshnessFromView(snapshot.views[KEYS.morphoMarkets(chainId)]);
  const apyKey = apySourceKey(chainId, apySource, market.collateralToken.address);
  const collateralApyFresh = apyKey ? freshnessFromView(snapshot.views[apyKey]) : undefined;
  // Prefer the live warmer's freshness; fall back to the baked file mtime until the first sweep.
  const exitFresh: FreshnessGroup | undefined = !exitLiquidity.measured
    ? undefined
    : freshnessFromView(snapshot.views[KEYS.exitLiquidity(chainId)]) ?? {
        asOf: collateralTokensAsOf,
        staleAfterSec: EXIT_LIQUIDITY_STALE_AFTER_SEC,
      };

  const collateral: Strategy["collateral"] = {
    address: market.collateralToken.address,
    symbol: market.collateralToken.symbol,
    name: market.collateralToken.name,
    decimals: market.collateralToken.decimals,
    category: info?.category ?? "Other",
    project: info?.project,
    yieldSource: info?.yieldSource,
    priceUsd: market.collateralToken.valueInUsd?.toNumber(),
    isPt: market.collateralToken.isPt,
    maturity: null, // on-chain maturity not read in the baseline (static maturityDate below)
    maturityDate: market.collateralToken.maturityDate ?? null,
    maturityDaysLeft: market.collateralToken.maturityDaysLeft ?? null,
    ...(market.collateralToken.underlying
      ? { underlying: { address: market.collateralToken.underlying.address, symbol: market.collateralToken.underlying.symbol } }
      : {}),
  };

  const strategy: Strategy = {
    id: market.morphoMarketId,
    chainId,
    correlated: market.correlated,
    collateral,
    loan: {
      address: market.loanToken.address,
      symbol: market.loanToken.symbol,
      decimals: market.loanToken.decimals,
      priceUsd: market.loanToken.valueInUsd?.toNumber(),
    },

    collateralApyPct: market.collateralToken.apy,
    collateralApySource: apySource,
    ...(collateralIncentive ? { collateralIncentive } : {}),
    yieldSustainabilityPct,
    ...(isToriCollateral(market.collateralToken.address)
      ? { pointsIncentive: { program: "Tori Cores", perDayPerCollateralToken: TORI_CORES_PER_TOKEN } }
      : {}),

    borrowApyPct: market.borrowApy,
    quarterlyBorrowApyPct: market.quarterlyBorrowApy,
    ...(borrowIncentive ? { borrowIncentive } : {}),
    netBorrowApyPct,

    supplyUsd,
    liquidityUsd,
    publicAllocatorLiquidityUsd,
    maxLeverage,
    ...(utilizationPct !== undefined ? { utilizationPct } : {}),

    leverageLadder: ladder,
    defaultLeverage: defaultPoint,
    historicalLeverageApyPct: {
      avg30d: honestHistorical(market.avg30dLeverageApy),
      avg60d: honestHistorical(market.avg60dLeverageApy),
      avg90d: honestHistorical(market.avg90dLeverageApy),
    },

    ltvPct: { liquidation: market.liqLtv, max: market.maxLtv },
    oracle: { address: market.oracle, ...(market.oracleType ? { type: market.oracleType } : {}) },
    exitLiquidity,
    noSwapRoute: info?.noSwapRoute === true,

    ...(spiralHints ? { spiralHints } : {}),

    freshness: {
      ...(borrowFresh ? { borrow: borrowFresh } : {}),
      ...(collateralApyFresh ? { collateralApy: collateralApyFresh } : {}),
      ...(exitFresh ? { exitLiquidity: exitFresh } : {}),
    },

    links: {
      // Must match the app's prerendered route exactly — `/strategy/:id` renders an empty SPA
      // shell, so an agent following it lands on a page with no content. The real page is
      // `/{chainId}/strategies/{id}/{collateralSymbol}-{loanSymbol}` (see the app's
      // scripts/prerender-routes.mjs, which writes one static page per market at that path).
      app: `${APP_BASE}/${chainId}/strategies/${market.morphoMarketId}/${market.collateralToken.symbol}-${market.loanToken.symbol}`,
      market: `https://app.morpho.org/ethereum/market/${market.morphoMarketId}`,
      ...(info?.website ? { yieldSource: info.website } : {}),
    },
  };

  return strategy;
}

export function buildStrategies(chainId: number): StrategiesEnvelope {
  const snapshot = composeSnapshot(chainId);
  // Agents see only eligible strategies (no fake-0 / thin / near-maturity / low-liquidity markets).
  const strategies = snapshot.markets
    .filter((cm) => cm.market.visible)
    .map((cm) => toStrategy(cm, snapshot));
  return { asOf: snapshot.asOf, chainId, count: strategies.length, strategies };
}

export function buildStrategy(chainId: number, id: string): Strategy | undefined {
  const snapshot = composeSnapshot(chainId);
  const cm = snapshot.markets.find((m) => m.market.morphoMarketId.toLowerCase() === id.toLowerCase());
  // A single strategy is only agent-visible if eligible — hide an ineligible one behind 404.
  return cm && cm.market.visible ? toStrategy(cm, snapshot) : undefined;
}
