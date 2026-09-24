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
  isManualExitOnly,
  LISTING_MAX_SLIPPAGE,
  DEPTH_MAX_SLIPPAGE,
} from "./exitLiquidity.ts";
import { avgCollateralApyOverDays } from "./leverageApy.ts";
import { collateralTokensAsOf } from "../data/markets.ts";
import { marketUrl, partnerMarketCurator } from "../data/robinhoodMarkets.ts";
import { KEYS, EXIT_LIQUIDITY_STALE_AFTER_SEC } from "../cache/policy.ts";
import type { FreshView } from "../cache/store.ts";
import { exitStableSymbol, type ExitLiquidityMap } from "../sources/exitLiquidity.ts";
import type {
  Strategy,
  LadderPoint,
  ExitLiquidity,
  FreshnessGroup,
  StrategiesEnvelope,
} from "../types/contract.ts";
import { composeSnapshot, apySourceKey, type ComposedMarket, type ComposedSnapshot } from "./compose.ts";
import { buildEquityMarkets } from "./equity.ts";

// Wrap synthetic equity Markets as ComposedMarkets so they map through toStrategy like loop markets.
// No APY/borrow history (a vault has no leverage-ladder history), and no collateral APY source.
const equityComposed = (chainId: number, snapshot: ComposedSnapshot): ComposedMarket[] =>
  buildEquityMarkets(chainId, snapshot.markets.map((cm) => cm.market)).map((market) => ({
    market,
    apySource: "none" as const,
    apyHistory: [],
    borrowHistory: [],
  }));

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
  // Equity vaults are a FIXED composite (deposit USDG → hold the stock + farm the borrowed slice),
  // not a user-selectable leverage ladder. Their one meaningful return is the net dollar APY, so the
  // ladder is a single point carrying it — never the fabricated integer steps a stock's 0% collateral
  // yield minus borrow would otherwise produce. The spiralHints.profile (below) explains the shape.
  if (market.equityVault) {
    const point: LadderPoint = {
      leverage: market.defaultLeverage, // "1" — the deposit isn't multiplied by a user leverage choice
      ltvPct: BigNumber(market.equityVault.targetLtvPct).toFixed(1), // stock-leg LTV (its liquidation risk)
      leverageApyPct: market.equityVault.netApyPct, // net dollar APY on the deposit
    };
    return { ladder: [point], maxLeverage: market.defaultLeverage, defaultPoint: point };
  }

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

function buildExitLiquidity(info: CollateralTokenInfo | undefined, asOf: string, chainId: number): ExitLiquidity {
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
    asOf,
    method: "onchain quote sweep",
    // The stable the sweep sold into on this chain (USDC on mainnet, USDG on Robinhood).
    direction: `collateral_to_${exitStableSymbol(chainId).toLowerCase()}`,
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
  // Morpho can report a hair more liquidity than supply on an idle market (rounding); that is 0%
  // utilised, never "-0.00".
  const utilizationPct =
    market.supplyAssets.isZero() || market.supplyAssets.isNegative()
      ? undefined
      : borrowedAssets.isNegative()
        ? "0.00"
        : borrowedAssets.div(market.supplyAssets).multipliedBy(100).toFixed(2);

  const publicAllocatorLiquidityUsd = market.paLiquidityAssets
    .multipliedBy(market.loanToken.valueInUsd)
    .toNumber();

  // Historical leverage APYs come pre-flipped for longs (computed via the app's calcLeverageApy);
  // un-flip them so the agent's historical series carries the same honest sign as the ladder.
  const honestHistorical = (v: string | undefined): string | undefined =>
    v === undefined ? undefined : market.correlated ? v : BigNumber(v).multipliedBy(-1).toFixed(2);

  // Exit slippage is served from the live sweep when THIS token was in it, else from the baked
  // collateralTokens.json seed — so `asOf` (and the freshness group below) name the timestamp of the
  // numbers actually shown, not the sweep's even when the token's own sweep failed.
  const exitView = snapshot.views[KEYS.exitLiquidity(chainId)] as FreshView<ExitLiquidityMap> | undefined;
  const swept = exitView?.value?.[market.collateralToken.address] !== undefined;
  const exitAsOf = swept ? exitView!.asOf : collateralTokensAsOf;

  // exit liquidity + the Spiral opinion block (isolated, with thresholds). Two overridable hints:
  // the exit-liquidity tier, and — for uncorrelated markets — how to read the (carry-only) APYs.
  const exitLiquidity = buildExitLiquidity(info, exitAsOf, chainId);
  const tier = exitLiquidityTier(info);
  const ev = market.equityVault;
  const spiralHints =
    tier === "unknown" && market.correlated && !ev
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
          ...(ev
            ? {
                profile: {
                  value: "equity_yield_vault",
                  leverageApyMeaning:
                    `Equity + yield vault: deposit USDG, hold ${market.collateralToken.symbol} as collateral (you stay ` +
                    `1x long ${market.collateralToken.symbol}), and the borrowed ${ev.targetLtvPct}% of its value is farmed ` +
                    `at ${ev.yieldLegApyPct}% net of the ${ev.stockBorrowApyPct}% stock-leg borrow. leverageApyPct is the ` +
                    `NET dollar APY on the deposit (${ev.netApyPct}%) — not a user-selectable leverage. Liquidates if ` +
                    `${market.collateralToken.symbol} falls to ltvPct.liquidation.`,
                },
              }
            : !market.correlated
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
  // Live sweep freshness when this token was swept; the baked file's otherwise.
  const exitFresh: FreshnessGroup | undefined = !exitLiquidity.measured
    ? undefined
    : swept
      ? freshnessFromView(exitView)
      : { asOf: collateralTokensAsOf, staleAfterSec: EXIT_LIQUIDITY_STALE_AFTER_SEC };

  const collateral: Strategy["collateral"] = {
    address: market.collateralToken.address,
    symbol: market.collateralToken.symbol,
    name: market.collateralToken.name,
    decimals: market.collateralToken.decimals,
    category: info?.category ?? "Other",
    project: info?.project,
    yieldSource: info?.yieldSource,
    ...(info?.description ? { description: info.description } : {}),
    priceUsd: market.collateralToken.valueInUsd?.toNumber(),
    isPt: market.collateralToken.isPt,
    maturity: null, // on-chain maturity not read in the baseline (static maturityDate below)
    maturityDate: market.collateralToken.maturityDate ?? null,
    maturityDaysLeft: market.collateralToken.maturityDaysLeft ?? null,
    ...(market.collateralToken.underlying
      ? { underlying: { address: market.collateralToken.underlying.address, symbol: market.collateralToken.underlying.symbol } }
      : {}),
  };

  // Partner-curated markets only: a vault names its stock market's curator from its own config; a
  // Longbow perp market resolves through the same registry the market link uses. Else absent.
  const curator = ev?.curator ?? partnerMarketCurator(chainId, market);

  const historicalWindows = Object.fromEntries(
    (
      [
        ["avg30d", honestHistorical(market.avg30dLeverageApy)],
        ["avg60d", honestHistorical(market.avg60dLeverageApy)],
        ["avg90d", honestHistorical(market.avg90dLeverageApy)],
      ] as const
    ).filter(([, v]) => v !== undefined),
  ) as Strategy["historicalLeverageApyPct"];
  const historicalLeverageApyPct = Object.keys(historicalWindows ?? {}).length > 0 ? historicalWindows : undefined;

  const strategy: Strategy = {
    id: market.morphoMarketId,
    chainId,
    correlated: market.correlated,
    ...(curator ? { curator } : {}),
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
    // Only the windows the market has history for; the block is ABSENT (not `{}`) when it has none
    // (an equity vault, or a market younger than 30 days) — absent = not measured, per the contract.
    ...(historicalLeverageApyPct ? { historicalLeverageApyPct } : {}),

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
      // Morpho's current market URL is `/{chain}/variable/{id}/{loan}-{collateral}` (the old
      // `/ethereum/market/{id}` form 404s, on every chain); a partner market links to its own
      // page (longbow.cash / NetNet Credit) instead — a vault's synthetic id has no Morpho page.
      market: marketUrl(chainId, market),
      ...(info?.website ? { yieldSource: info.website } : {}),
    },
  };

  return strategy;
}

// Agent-facing eligibility. `visible` is the app's listing flag; a manual-exit market is visible in
// the app (which withholds one-click close and walks the user through repay + withdraw) but stays
// off the agent surface: an agent cannot unwind it through `close`, so it is neither discoverable
// nor leverageable here.
export function isAgentEligible(market: Market): boolean {
  return market.visible === true && !isManualExitOnly(market.collateralToken.info);
}

export function buildStrategies(chainId: number): StrategiesEnvelope {
  const snapshot = composeSnapshot(chainId);
  // Agents see only eligible strategies (no fake-0 / thin / near-maturity / low-liquidity markets).
  // Equity vaults are appended here so agents discover them alongside the loop markets.
  const strategies = [...snapshot.markets, ...equityComposed(chainId, snapshot)]
    .filter((cm) => isAgentEligible(cm.market))
    .map((cm) => toStrategy(cm, snapshot));
  return { asOf: snapshot.asOf, chainId, count: strategies.length, strategies };
}

export function buildStrategy(chainId: number, id: string): Strategy | undefined {
  const snapshot = composeSnapshot(chainId);
  const cm =
    snapshot.markets.find((m) => m.market.morphoMarketId.toLowerCase() === id.toLowerCase()) ??
    equityComposed(chainId, snapshot).find((m) => m.market.morphoMarketId.toLowerCase() === id.toLowerCase());
  // A single strategy is only agent-visible if eligible — hide an ineligible one behind 404.
  return cm && isAgentEligible(cm.market) ? toStrategy(cm, snapshot) : undefined;
}
