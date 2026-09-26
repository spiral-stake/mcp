// Ops portfolio — a wallet's positions EXACTLY as the app's Portfolio page shows them, so the
// dashboard can monitor what each user sees. This is a port of the app's derivation chain:
//   contract-hooks/FlashLeverage.calcPostionData  (on-chain facts + dashboard row → LeveragePosition)
//   utils/positionYield.ts                        (yield / ROE / spot P&L, incentives folded in)
//   utils/getNetYieldUsd.ts                       (Projected Yield)
//   utils/equityPosition.ts                       (vault deposit reconstruction, closed-vault remap)
//   components/portfolio/LeveragePositionCard.tsx (the OpenPositionView / ClosedOrMaturedView rows)
//   components/portfolio/EquityPositionCard.tsx   (the vault card)
// Every value below is emitted UNFORMATTED (full-precision decimal strings); the consumer formats
// with the app's displayTokenAmount so rounding matches to the displayed digit.
//
// Unlike the app this is READ-ONLY: where the app self-heals a missing/stale dashboard row by
// re-registering it, this reports the discrepancy in `dbDrift` instead. That is the monitoring
// signal the app itself never shows.
import BigNumber from "bignumber.js";
import { formatUnits } from "../core/formatUnits.ts";
import { calcLeverage, calcLeverageApy } from "../core/leverage.ts";
import {
  exitLiquidityTier,
  exitLiquiditySize,
  exitLiquidityCleanSizeUsd,
  isManualExitOnly,
  type ExitLiquidityTier,
} from "../core/exitLiquidity.ts";
import { incentiveAprAt, type MerklAprRecord } from "../sources/merkl.ts";
import { composeSnapshot } from "../core/compose.ts";
import { buildEquityMarkets } from "../core/equity.ts";
import { appStrategyLink, externalMarketLink, type ExternalLinkKind } from "../core/marketLinks.ts";
import { readUserPositionsRaw, toPositionView, type RawUserPosition } from "./positions.ts";
import { getUserEquityPositions, type EquityPositionView, type YieldLoopMatch } from "./equity.ts";
import { SWAP_FEE_BPS, NON_CORRELATED_SWAP_FEE_BPS } from "./swap.ts";
import { discoverChainUsers } from "../sources/tvl.ts";
import { readMarkets } from "../data/markets.ts";
import { SUPPORTED_CHAIN_IDS } from "../config/chains.ts";
import { getJson } from "../sources/http.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS, POLICY } from "../cache/policy.ts";
import { env } from "../config/env.ts";
import { log } from "../config/logger.ts";
import type { Market, EquityVaultInfo } from "../types/index.ts";

// ── wire shapes ───────────────────────────────────────────────────────────────────────────────────
// Numbers are decimal strings at full precision unless typed `number`.

export type DbDrift =
  | "no_db_row" // open/closed on chain, no dashboard row (the app would re-register an open one)
  | "db_open_chain_closed" // the row still says open; the chain says closed (a close registration was lost)
  | "db_closed_chain_open"; // the row says closed; the chain says open (should not happen)

export interface PortfolioMarket {
  morphoMarketId: string;
  correlated: boolean;
  project: string; // card title (the collateral's project; the stock symbol for a closed vault)
  description?: string;
  collateralSymbol: string;
  collateralSymbolExtended?: string; // icon filename for PTs
  collateralAddress: string;
  loanSymbol: string;
  loanAddress: string;
  isPt: boolean;
  pt: { maturityDate: string; daysLeft: number; matured: boolean } | null; // maturityDate as the app's badge prints it
  liqLtvPct: string;
  oracleRate: string; // loan tokens per 1 collateral (collateralTokenValueInLoanToken)
  collateralPriceUsd: string;
  loanPriceUsd: string;
  collateralApyPct: string;
  borrowApyPct: string;
  incentives: {
    borrowApy: string;
    borrowBreakdown: { symbol: string; apy: string }[];
    borrowUrl?: string;
    collateralApy: string;
    collateralBreakdown: { symbol: string; apy: string }[];
    collateralUrl?: string;
  };
  exitLiquidity: {
    tier: ExitLiquidityTier;
    cleanExitSize: string;
    unwindSizeUsd: number;
    exceedsCleanExitSize: boolean;
    manualExitOnly: boolean;
    noSwapRoute: boolean;
  };
  equityVault: boolean;
  links: { app: string; external: string; externalKind: ExternalLinkKind };
}

export interface PortfolioYield {
  baseUsd: string; // on-chain P&L: equity delta while open, returned − deposited once closed
  incentiveUsd: string; // Merkl borrow + collateral rewards accrued over the position's life
  totalUsd: string; // baseUsd + incentiveUsd — the figure every surface shows
  roePct: string;
  incentiveSymbols: string; // "DOLA + USDG" — labels the "(incl. $X rewards)" note
}

// `$X (+Y%)` pair, as RoeView prints it (signed by usd).
export interface PnlLine {
  usd: string;
  pct: string;
}

// The stat row of an open (or liquidated) card — OpenPositionView, field for field.
export interface OpenView {
  amountDeposited: { loanToken: string; usd: string; source: "db" | "chain" };
  totalSupplied: { label: "Total Supplied" | "Exposure"; collateral: string; usd: string; leverage: string | null };
  borrowed: { loanToken: string; usd: string };
  // Correlated loops: "Projected Yield · Nd" (forward projection + realized yield incl. rewards).
  projectedYield: { days: number; loanToken: string; usd: string; yieldGenerated: { loanToken: string; usd: string } } | null;
  // Perps: "Profit" with/without leverage when an entry price was recorded, else plain ROE.
  profit: { withLeverage: PnlLine; withoutLeverage: PnlLine | null } | null;
  ltv: { pct: string; liqPct: string };
  price: { current: string; breakEven: string | null; liquidation: string; dropToLiquidationPct: string } | null;
}

// The stat row of a closed card — ClosedOrMaturedView, field for field.
export interface ClosedView {
  amountDeposited: { loanToken: string; usd: string; source: "db" | "chain" };
  amountReturned: { loanToken: string; usd: string; claimableIncentiveUsd: string }; // usd includes claimable rewards
  yieldGenerated: { loanToken: string; usd: string } | null; // correlated loops
  profit: { withLeverage: PnlLine; withoutLeverage: PnlLine | null } | null; // perps (RoeView)
}

export interface PortfolioDbRow {
  positionId: string; // `${user}-${morphoMarketId}-${index}` (lowercase)
  user?: string;
  chainId?: number;
  open: boolean;
  amountDepositedInUsd: number;
  amountAddedInUsd?: number;
  amountRemovedInUsd?: number;
  amountReturnedInUsd?: number;
  atTokenApy?: number;
  atBorrowApy?: number;
  desiredLtv: number;
  equityMarketId?: string;
  entryPriceUsd?: number;
  exitPriceUsd?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface PortfolioPosition {
  id: number;
  positionId: string; // `${chainId}-${morphoMarketId}-${id}`
  chainId: number;
  userProxy: string;
  status: "open" | "liquidated" | "closed";
  market: PortfolioMarket;
  openedAt: string | null;
  leverage: string; // calcLeverage(live ltv), 1dp — the "Nx" badge
  leverageApyPct: string; // the card's APY badge figure (sign-flipped for perps, as the app)
  apyBadge: string; // "23.41% APY" / "-8.10% Borrow APY · Matures Dec 15, 2026 · 80 Days Left"
  onchain: {
    amountDepositedInLoanToken: string; // the app's cost basis (open: raw; closed: raw + returned)
    amountReturnedInLoanToken: string;
    amountLeveragedCollateral: string;
    amountCollateral: string; // equity in collateral units
    amountCollateralInLoanToken: string;
    amountLoan: string;
    ltvPct: string;
  };
  db: {
    depositedUsd: number; // amountDepositedInUsd + amountAddedInUsd
    returnedUsd?: number; // closed only: amountReturnedInUsd + amountRemovedInUsd
    yieldUsd?: number;
    equityMarketId?: string;
    entryPriceUsd?: number;
    exitPriceUsd?: number;
    desiredLtv: number;
    atTokenApy?: number;
    atBorrowApy?: number;
    row: PortfolioDbRow;
  } | null;
  yield: PortfolioYield;
  view: { open: OpenView; closed: null } | { open: null; closed: ClosedView };
  dbDrift: DbDrift[];
}

export interface EquityPortfolioPosition {
  strategyId: string; // the vault's synthetic id
  chainId: number;
  userProxy: string; // the representative loop's proxy (Merkl / Tori lookups)
  curator: string;
  stockSymbol: string;
  yieldSink: string; // "syrupUSDG (Maple)"
  openedAt: string | null;
  netApyPct: string;
  apyBadge: string; // "1.23% net APY"
  yieldLoopIds: number[];
  yieldLoopMatch: YieldLoopMatch;
  ambiguousYieldLoopIds?: number[];
  depositedUsd: string;
  depositedUsdg: string;
  totalValueUsd: string; // ≈ what a full close returns
  profitUsd: string; // totalValue − deposited
  yieldLegUsd: string; // what the yield leg earned net of the stock borrow cost
  stock: {
    collateral: string;
    collateralUsd: string;
    priceUsd: string;
    debtUsdg: string;
    debtUsd: string;
    ltvPct: string;
    liqLtvPct: string;
    liquidationPriceUsd: string;
    dropToLiquidationPct: string;
    borrowApyPct: string;
  };
  market: PortfolioMarket;
  view: OpenView; // the standard stat row, driven by the stock leg with the vault-wide P&L
  yield: PortfolioYield;
  dbDrift: DbDrift[];
}

export interface UnresolvedRow {
  row: PortfolioDbRow;
  // chain_mismatch: the row's market lives on ANOTHER supported chain — the row was registered under
  // the wrong chainId (pre-multichain clients defaulted to 1), so the app on the right chain never
  // finds it and shows that position from its on-chain basis instead.
  reason: "market_not_configured" | "no_chain_position" | "chain_mismatch";
}

export interface WalletPortfolio {
  address: string;
  chainId: number;
  header: { totalDepositedUsd: string; openCount: number };
  positions: PortfolioPosition[]; // open, non-liquidated plain loops (a vault's loops excluded)
  equityPositions: EquityPortfolioPosition[];
  closed: PortfolioPosition[]; // closed + liquidated, closed vaults re-skinned
  unresolved: UnresolvedRow[]; // dashboard rows with no chain position behind them
}

export interface PortfoliosPayload {
  chainId: number;
  computedAt: string;
  users: WalletPortfolio[];
  counts: { users: number; open: number; equity: number; closed: number; unresolved: number; drift: number };
}

export interface PortfoliosResponse extends PortfoliosPayload {
  asOf: string;
  stale: boolean;
  degraded: boolean; // the latest recompute failed; serving last-good
}

// ── dashboard rows ────────────────────────────────────────────────────────────────────────────────
const DASHBOARD_PAGE = 500;

// Row key the app uses to pair a row with its chain position: `${marketId}-${index}` (lowercase).
const rowKey = (positionId: string) => positionId.split("-").slice(1).join("-").toLowerCase();

export async function fetchDashboardRows(chainId: number, user?: string): Promise<PortfolioDbRow[]> {
  if (!env.DASHBOARD_URL) return [];
  if (user) {
    return (
      (await getJson<PortfolioDbRow[]>(`${env.DASHBOARD_URL}/leverage/${user.toLowerCase()}?chainId=${chainId}`, {
        source: "dashboard",
        retries: 2,
      })) ?? []
    );
  }
  const rows: PortfolioDbRow[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch =
      (await getJson<PortfolioDbRow[]>(`${env.DASHBOARD_URL}/leverage?chainId=${chainId}&limit=${DASHBOARD_PAGE}&page=${page}`, {
        source: "dashboard",
        retries: 2,
      })) ?? [];
    rows.push(...batch);
    if (batch.length < DASHBOARD_PAGE) break;
  }
  return rows;
}

// ── incentive accrual (FlashLeverage.ts: integrateIncentiveUsd / accruedIncentiveUsd) ────────────
const YEAR_MS = 365 * 86_400_000;

function integrateIncentiveUsd(history: MerklAprRecord[], notionalUsd: number, openMs: number, closeMs: number): number {
  if (!history.length || notionalUsd <= 0 || closeMs <= openMs) return 0;
  const checkpoints = [openMs, ...history.filter((r) => r.ts > openMs && r.ts < closeMs).map((r) => r.ts), closeMs];
  let total = 0;
  for (let i = 0; i < checkpoints.length - 1; i++) {
    const apr = incentiveAprAt(history, checkpoints[i]);
    if (apr > 0) total += (apr / 100) * notionalUsd * ((checkpoints[i + 1] - checkpoints[i]) / YEAR_MS);
  }
  return total;
}

export function accruedIncentiveUsd(
  history: MerklAprRecord[],
  spotApr: string,
  notionalUsd: number,
  openMs: number,
  closeMs: number,
): number {
  if (notionalUsd <= 0 || openMs <= 0 || closeMs <= openMs) return 0;
  if (history.length > 0) return integrateIncentiveUsd(history, notionalUsd, openMs, closeMs);
  if (Number(spotApr) > 0) return (Number(spotApr) / 100) * notionalUsd * ((closeMs - openMs) / YEAR_MS);
  return 0;
}

// ── the app's LeveragePosition (FlashLeverage.calcPostionData) ───────────────────────────────────
interface AppPosition {
  id: number;
  open: boolean;
  userProxy: string;
  market: Market;
  amountCollateral: BigNumber;
  amountCollateralInLoanToken: BigNumber;
  amountDepositedInLoanToken: BigNumber; // cost basis (closed: raw + returned)
  amountReturnedInLoanToken: BigNumber;
  amountLeveragedCollateral: BigNumber;
  amountLoan: BigNumber;
  ltv: string;
  liquidated: boolean;
  leverage: string;
  leverageApy: string;
  incentiveAccruedUsd: number;
  openedAt?: string;
  entryPriceUsd?: number;
  exitPriceUsd?: number;
  dbData?: { depositedUsd: number; returnedUsd?: number; yieldUsd?: number; equityMarketId?: string };
  row?: PortfolioDbRow;
}

export function calcAppPosition(p: RawUserPosition, row: PortfolioDbRow | undefined, nowMs: number): AppPosition {
  const { market, open } = p;
  const { collateralToken } = market;
  const amountDepositedInLoanToken = formatUnits(p.amountDepositedRaw, market.loanToken.decimals);
  const amountReturnedInLoanToken = formatUnits(p.amountReturnedRaw, market.loanToken.decimals);
  const amountLeveragedCollateral = formatUnits(p.collateralRaw, collateralToken.decimals);
  const amountLoan = formatUnits(p.loanRaw, market.loanToken.decimals);

  // Collateral yield = base APY snapshotted at open (when recorded) + the CURRENT collateral incentive.
  const baseCollateralApy = row?.atTokenApy !== undefined && row?.atTokenApy !== null ? String(row.atTokenApy) : collateralToken.apy;
  const effectiveApy = BigNumber(baseCollateralApy).plus(market.collateralIncentiveApy ?? "0").toFixed(2);

  // On a closed position the contract's stored deposit is a residual (deposit − returned, floored at
  // 0); adding the return back recovers the original basis wherever the close was at a loss.
  const amountDepositedBasisInLoanToken = open ? amountDepositedInLoanToken : amountDepositedInLoanToken.plus(amountReturnedInLoanToken);

  const rate = market.collateralTokenValueInLoanToken;
  const amountCollateral = amountLeveragedCollateral.minus(amountLoan.div(rate));
  const amountCollateralInLoanToken = amountCollateral.multipliedBy(rate);
  const amountLeveragedCollateralInLoanToken = amountLeveragedCollateral.multipliedBy(rate);

  const ltv = amountLeveragedCollateralInLoanToken.isZero()
    ? "0.00"
    : amountLoan.multipliedBy(100).div(amountLeveragedCollateralInLoanToken).toFixed(2);

  const liquidated = open && amountLeveragedCollateral.isZero();
  const posOpenMs = row?.createdAt ? new Date(row.createdAt).getTime() : 0;

  let dbData: AppPosition["dbData"];
  if (row?.amountDepositedInUsd) {
    const depositedUsd = row.amountDepositedInUsd + (row.amountAddedInUsd ?? 0);
    const returnedUsd =
      (!open || liquidated) && row.amountReturnedInUsd ? row.amountReturnedInUsd + (row.amountRemovedInUsd ?? 0) : undefined;
    dbData = {
      depositedUsd,
      returnedUsd,
      yieldUsd: returnedUsd !== undefined ? returnedUsd - depositedUsd : undefined,
      equityMarketId: row.equityMarketId,
    };
  }

  let incentiveAccruedUsd = 0;
  if (posOpenMs > 0 && !liquidated) {
    let borrowNotionalUsd = 0;
    let collateralNotionalUsd = 0;
    let closeMs = nowMs;
    if (open) {
      borrowNotionalUsd = amountLoan.toNumber() * market.loanToken.valueInUsd.toNumber();
      collateralNotionalUsd = amountLeveragedCollateral.toNumber() * collateralToken.valueInUsd.toNumber();
    } else if (dbData) {
      const ltvFrac = (row?.desiredLtv ?? 0) / 100;
      if (ltvFrac > 0 && ltvFrac < 1) {
        collateralNotionalUsd = dbData.depositedUsd / (1 - ltvFrac);
        borrowNotionalUsd = collateralNotionalUsd - dbData.depositedUsd;
      }
      if (row?.updatedAt) closeMs = new Date(row.updatedAt).getTime();
    }
    incentiveAccruedUsd =
      accruedIncentiveUsd(market.borrowIncentiveHistory, market.borrowIncentiveApy, borrowNotionalUsd, posOpenMs, closeMs) +
      accruedIncentiveUsd(market.collateralIncentiveHistory, market.collateralIncentiveApy ?? "0", collateralNotionalUsd, posOpenMs, closeMs);
  }

  return {
    id: p.id,
    open,
    userProxy: p.userProxy,
    market,
    amountCollateral,
    amountCollateralInLoanToken,
    amountDepositedInLoanToken: amountDepositedBasisInLoanToken,
    amountReturnedInLoanToken,
    amountLeveragedCollateral,
    amountLoan,
    ltv,
    liquidated,
    leverage: calcLeverage(ltv),
    leverageApy: calcLeverageApy(market.correlated, effectiveApy, BigNumber(market.borrowApy).minus(market.borrowIncentiveApy).toFixed(2), ltv),
    incentiveAccruedUsd,
    openedAt: row?.createdAt,
    entryPriceUsd: row?.entryPriceUsd,
    exitPriceUsd: row?.exitPriceUsd,
    dbData,
    row,
  };
}

// ── utils/positionYield.ts ────────────────────────────────────────────────────────────────────────
interface PositionYield {
  baseUsd: number;
  incentiveUsd: number;
  totalUsd: number;
}

const getDepositedUsd = (pos: AppPosition): BigNumber =>
  pos.dbData?.depositedUsd != null ? BigNumber(pos.dbData.depositedUsd) : pos.amountDepositedInLoanToken.multipliedBy(pos.market.loanToken.valueInUsd);

const getReturnedUsd = (pos: AppPosition): BigNumber =>
  pos.dbData?.returnedUsd !== undefined ? BigNumber(pos.dbData.returnedUsd) : pos.amountReturnedInLoanToken.multipliedBy(pos.market.loanToken.valueInUsd);

const getBaseUsd = (pos: AppPosition): number => {
  if (pos.open) {
    const equity = pos.amountLeveragedCollateral.multipliedBy(pos.market.collateralTokenValueInLoanToken).minus(pos.amountLoan);
    return equity.minus(pos.amountDepositedInLoanToken).multipliedBy(pos.market.loanToken.valueInUsd).toNumber();
  }
  if (pos.dbData?.yieldUsd !== undefined) return pos.dbData.yieldUsd;
  return getReturnedUsd(pos).minus(getDepositedUsd(pos)).toNumber();
};

const getPositionYield = (pos: AppPosition, baseUsdOverride?: number): PositionYield => {
  const baseUsd = baseUsdOverride ?? getBaseUsd(pos);
  const incentiveUsd = pos.incentiveAccruedUsd;
  return { baseUsd, incentiveUsd, totalUsd: baseUsd + incentiveUsd };
};

const getYieldInLoanToken = (pos: AppPosition, y: PositionYield): BigNumber =>
  pos.market.loanToken.valueInUsd.isZero() ? BigNumber(0) : BigNumber(y.totalUsd).dividedBy(pos.market.loanToken.valueInUsd);

const getReturnedUsdTotal = (pos: AppPosition, y: PositionYield): BigNumber => getReturnedUsd(pos).plus(BigNumber.max(y.incentiveUsd, 0));

const getRoePercent = (pos: AppPosition, y: PositionYield): BigNumber => {
  const depositedUsd = getDepositedUsd(pos);
  return depositedUsd.isZero() ? BigNumber(0) : BigNumber(y.totalUsd).dividedBy(depositedUsd).multipliedBy(100);
};

const getSpotPnl = (pos: AppPosition): { usd: number; pct: number } | null => {
  const entry = pos.entryPriceUsd;
  const priceNow = pos.open ? pos.market.collateralToken.valueInUsd.toNumber() : pos.exitPriceUsd;
  if (!entry || entry <= 0 || !priceNow || priceNow <= 0) return null;
  const pct = ((priceNow - entry) / entry) * 100;
  return { usd: getDepositedUsd(pos).toNumber() * (pct / 100), pct };
};

const getIncentiveSymbols = (market: Market): string =>
  [...market.borrowIncentiveBreakdown, ...market.collateralIncentiveBreakdown]
    .map((b) => b.symbol)
    .filter((s, i, all) => all.indexOf(s) === i)
    .join(" + ");

// utils/getNetYieldUsd.ts getProjectedYieldInLoanToken (YIELD_FEE_PERCENT = 0, EXIT_SLIPPAGE_PERCENT = 0).
const projectedDays = (pos: AppPosition) => pos.market.collateralToken.maturityDaysLeft || env.PORTFOLIO_DEFAULT_DAYS;
const getProjectedYieldInLoanToken = (pos: AppPosition): number =>
  (Number(pos.leverageApy) / 100) * Number(pos.amountCollateralInLoanToken) * (projectedDays(pos) / 365);

// ── serialization of the card rows ────────────────────────────────────────────────────────────────
const str = (v: BigNumber | number): string => (v instanceof BigNumber ? v.toFixed() : BigNumber(v).toFixed());

const pnlLine = (usd: number, pct: number): PnlLine => ({ usd: str(usd), pct: str(pct) });

// RoeView: leveraged vs unleveraged when an entry price was recorded, else the single ROE line.
function profitView(pos: AppPosition, y: PositionYield) {
  const roe = getRoePercent(pos, y);
  const spot = getSpotPnl(pos);
  return {
    withLeverage: pnlLine(y.totalUsd, roe.toNumber()),
    withoutLeverage: spot ? pnlLine(spot.usd, spot.pct) : null,
  };
}

function amountDepositedView(pos: AppPosition): OpenView["amountDeposited"] {
  if (pos.dbData?.depositedUsd != null) {
    const usd = BigNumber(pos.dbData.depositedUsd);
    return { loanToken: str(usd.dividedBy(pos.market.loanToken.valueInUsd)), usd: str(usd), source: "db" };
  }
  return {
    loanToken: str(pos.amountDepositedInLoanToken),
    usd: str(pos.amountDepositedInLoanToken.multipliedBy(pos.market.loanToken.valueInUsd)),
    source: "chain",
  };
}

export function openView(pos: AppPosition, opts: { baseUsdOverride?: number; hideLeverageBadge?: boolean } = {}): OpenView {
  const liquidated = pos.liquidated;
  const y = getPositionYield(pos, opts.baseUsdOverride);
  const projectedTotalInLoanToken = BigNumber(getProjectedYieldInLoanToken(pos)).plus(getYieldInLoanToken(pos, y));
  const loanPrice = pos.market.loanToken.valueInUsd;
  const liqLtv = pos.market.liqLtv;

  return {
    amountDeposited: amountDepositedView(pos),
    totalSupplied: {
      label: pos.market.correlated ? "Total Supplied" : "Exposure",
      collateral: str(pos.amountLeveragedCollateral),
      usd: str(pos.amountLeveragedCollateral.multipliedBy(pos.market.collateralToken.valueInUsd)),
      leverage: !liquidated && !opts.hideLeverageBadge ? calcLeverage(pos.ltv) : null,
    },
    borrowed: { loanToken: str(pos.amountLoan), usd: str(pos.amountLoan.multipliedBy(loanPrice)) },
    projectedYield:
      !liquidated && pos.market.correlated
        ? {
            days: projectedDays(pos),
            loanToken: str(BigNumber.max(projectedTotalInLoanToken, 0)),
            usd: str(BigNumber.max(BigNumber(0), projectedTotalInLoanToken.multipliedBy(loanPrice))),
            yieldGenerated: {
              loanToken: str(BigNumber.max(getYieldInLoanToken(pos, y), 0)),
              usd: str(BigNumber.max(BigNumber(y.totalUsd), 0)),
            },
          }
        : null,
    profit: !liquidated && !pos.market.correlated ? profitView(pos, y) : null,
    ltv: { pct: pos.ltv, liqPct: liqLtv },
    price: liquidated
      ? null
      : {
          current: str(pos.market.collateralTokenValueInLoanToken),
          breakEven:
            !pos.market.correlated && pos.amountLeveragedCollateral.gt(0)
              ? str(pos.amountLoan.plus(pos.amountDepositedInLoanToken).dividedBy(pos.amountLeveragedCollateral))
              : null,
          liquidation: str(BigNumber(pos.ltv).dividedBy(BigNumber(liqLtv)).multipliedBy(pos.market.collateralTokenValueInLoanToken)),
          dropToLiquidationPct: ((1 - Number(pos.ltv) / Number(liqLtv)) * 100).toFixed(1),
        },
  };
}

export function closedView(pos: AppPosition): ClosedView {
  const y = getPositionYield(pos);
  const loanPrice = pos.market.loanToken.valueInUsd;
  const returnedTotalUsd = getReturnedUsdTotal(pos, y);
  const returnedTotalInLoanToken = loanPrice.isZero() ? BigNumber(0) : returnedTotalUsd.dividedBy(loanPrice);
  const deposited: ClosedView["amountDeposited"] = pos.dbData
    ? { loanToken: str(BigNumber(pos.dbData.depositedUsd).div(loanPrice)), usd: str(pos.dbData.depositedUsd), source: "db" }
    : { loanToken: str(pos.amountDepositedInLoanToken), usd: str(pos.amountDepositedInLoanToken.multipliedBy(loanPrice)), source: "chain" };
  return {
    amountDeposited: deposited,
    amountReturned: {
      loanToken: str(returnedTotalInLoanToken),
      usd: str(returnedTotalUsd),
      claimableIncentiveUsd: str(BigNumber.max(y.incentiveUsd, 0)),
    },
    yieldGenerated: pos.market.correlated
      ? { loanToken: str(BigNumber.max(getYieldInLoanToken(pos, y), 0)), usd: str(BigNumber.max(BigNumber(y.totalUsd), 0)) }
      : null,
    profit: pos.market.correlated ? null : profitView(pos, y),
  };
}

// "15 DEC 2026" (the app's maturityDate) → "Dec 15, 2026" (how the APY badge prints it).
function badgeMaturity(maturityDate?: string): string {
  const [d, m = "", y] = (maturityDate ?? "").split(" ");
  const month = m ? m[0] + m.slice(1).toLowerCase() : "";
  return `${month} ${d}, ${y}`;
}

function apyBadgeText(pos: AppPosition): string {
  const ct = pos.market.collateralToken;
  const pt = ct.isPt ? ` · Matures ${badgeMaturity(ct.maturityDate)} · ${ct.maturityDaysLeft} Days Left` : "";
  return `${pos.leverageApy}% ${pos.market.correlated ? "APY" : "Borrow APY"}${pt}`;
}

function marketView(market: Market, chainId: number, unwindSizeUsd: number, project = market.collateralToken.info?.project ?? market.collateralToken.symbol): PortfolioMarket {
  const ct = market.collateralToken;
  const info = ct.info;
  const cleanSizeUsd = exitLiquidityCleanSizeUsd(info);
  const manualExitOnly = isManualExitOnly(info);
  const ext = externalMarketLink(market, chainId);
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    morphoMarketId: market.morphoMarketId,
    correlated: market.correlated,
    project,
    description: info?.description,
    collateralSymbol: ct.symbol,
    collateralSymbolExtended: ct.symbolExtended,
    collateralAddress: ct.address,
    loanSymbol: market.loanToken.symbol,
    loanAddress: market.loanToken.address,
    isPt: ct.isPt,
    pt: ct.isPt ? { maturityDate: badgeMaturity(ct.maturityDate), daysLeft: ct.maturityDaysLeft ?? 0, matured: ct.maturity !== undefined && nowSec > ct.maturity } : null,
    liqLtvPct: market.liqLtv,
    oracleRate: str(market.collateralTokenValueInLoanToken),
    collateralPriceUsd: str(ct.valueInUsd),
    loanPriceUsd: str(market.loanToken.valueInUsd),
    collateralApyPct: ct.apy,
    borrowApyPct: market.borrowApy,
    incentives: {
      borrowApy: market.borrowIncentiveApy,
      borrowBreakdown: market.borrowIncentiveBreakdown,
      borrowUrl: market.borrowIncentiveUrl,
      collateralApy: market.collateralIncentiveApy,
      collateralBreakdown: market.collateralIncentiveBreakdown,
      collateralUrl: market.collateralIncentiveUrl,
    },
    exitLiquidity: {
      tier: exitLiquidityTier(info),
      cleanExitSize: exitLiquiditySize(info),
      unwindSizeUsd: Number(unwindSizeUsd.toFixed(2)),
      exceedsCleanExitSize: !manualExitOnly && unwindSizeUsd > 0 && unwindSizeUsd > cleanSizeUsd,
      manualExitOnly,
      noSwapRoute: !!info?.noSwapRoute,
    },
    equityVault: !!market.equityVault,
    links: { app: appStrategyLink(env.APP_URL, market, chainId), external: ext.url, externalKind: ext.kind },
  };
}

function yieldView(pos: AppPosition, y: PositionYield): PortfolioYield {
  return {
    baseUsd: str(y.baseUsd),
    incentiveUsd: str(y.incentiveUsd),
    totalUsd: str(y.totalUsd),
    roePct: str(getRoePercent(pos, y)),
    incentiveSymbols: getIncentiveSymbols(pos.market),
  };
}

function dbView(pos: AppPosition): PortfolioPosition["db"] {
  if (!pos.dbData || !pos.row) return null;
  return {
    ...pos.dbData,
    entryPriceUsd: pos.row.entryPriceUsd,
    exitPriceUsd: pos.row.exitPriceUsd,
    desiredLtv: pos.row.desiredLtv,
    atTokenApy: pos.row.atTokenApy,
    atBorrowApy: pos.row.atBorrowApy,
    row: pos.row,
  };
}

function driftOf(pos: AppPosition): DbDrift[] {
  const out: DbDrift[] = [];
  if (!pos.row) out.push("no_db_row");
  else if (pos.row.open && !pos.open) out.push("db_open_chain_closed");
  else if (!pos.row.open && pos.open && !pos.liquidated) out.push("db_closed_chain_open");
  return out;
}

export function serializePosition(pos: AppPosition, chainId: number): PortfolioPosition {
  const y = getPositionYield(pos);
  const unwindSizeUsd = pos.amountLeveragedCollateral.multipliedBy(pos.market.collateralToken.valueInUsd).toNumber();
  const status: PortfolioPosition["status"] = pos.open ? (pos.liquidated ? "liquidated" : "open") : "closed";
  return {
    id: pos.id,
    positionId: `${chainId}-${pos.market.morphoMarketId}-${pos.id}`,
    chainId,
    userProxy: pos.userProxy,
    status,
    market: marketView(pos.market, chainId, unwindSizeUsd),
    openedAt: pos.openedAt ?? null,
    leverage: pos.leverage,
    leverageApyPct: pos.leverageApy,
    apyBadge: apyBadgeText(pos),
    onchain: {
      amountDepositedInLoanToken: str(pos.amountDepositedInLoanToken),
      amountReturnedInLoanToken: str(pos.amountReturnedInLoanToken),
      amountLeveragedCollateral: str(pos.amountLeveragedCollateral),
      amountCollateral: str(pos.amountCollateral),
      amountCollateralInLoanToken: str(pos.amountCollateralInLoanToken),
      amountLoan: str(pos.amountLoan),
      ltvPct: pos.ltv,
    },
    db: dbView(pos),
    yield: yieldView(pos, y),
    // The app renders the OpenPositionView (liquidated variant) for a liquidated position even though
    // it sits in the closed list, and the ClosedOrMaturedView only once the contract marks it closed.
    view: pos.open ? { open: openView(pos), closed: null } : { open: null, closed: closedView(pos) },
    dbDrift: driftOf(pos),
  };
}

// ── equity vaults (utils/equityPosition.ts + EquityPositionCard.tsx) ─────────────────────────────
const EQUITY_ENTRY_SLIPPAGE = 0.01;

// The user's USDG in for one vault yield leg (utils/equityPosition.ts vaultLoopDepositUsd).
export function vaultLoopDepositUsd(loop: AppPosition, ev: EquityVaultInfo): BigNumber {
  const basisUsd = loop.amountDepositedInLoanToken.multipliedBy(loop.market.loanToken.valueInUsd);
  const db = loop.dbData;
  if (db != null) {
    const recoveredAsPlainLoop = !db.equityMarketId && BigNumber(db.depositedUsd).minus(basisUsd).abs().lte(basisUsd.multipliedBy(0.01));
    if (!recoveredAsPlainLoop) return BigNumber(db.depositedUsd);
  }
  const targetLtv = BigNumber(ev.targetLtvPct).div(100);
  if (targetLtv.lte(0)) return basisUsd;
  return basisUsd
    .div(1 - SWAP_FEE_BPS / 10000)
    .div(targetLtv)
    .div(1 - EQUITY_ENTRY_SLIPPAGE)
    .div(1 - NON_CORRELATED_SWAP_FEE_BPS / 10000);
}

function serializeEquity(
  ev: EquityPositionView,
  equityMarket: Market,
  loops: AppPosition[],
  chainId: number,
): EquityPortfolioPosition {
  const info = equityMarket.equityVault!;
  const usdgPrice = equityMarket.loanToken.valueInUsd;
  const stock = equityMarket.collateralToken;
  const yieldPosition = loops[0];
  const yieldSink = yieldPosition.market.collateralToken.info?.project
    ? `${yieldPosition.market.collateralToken.symbol} (${yieldPosition.market.collateralToken.info.project})`
    : yieldPosition.market.collateralToken.symbol;

  const collateral = formatUnits(BigInt(ev.stock.collateralRaw), stock.decimals);
  const collateralUsd = collateral.multipliedBy(stock.valueInUsd);
  const debtUsdg = formatUnits(BigInt(ev.stock.debtRaw), equityMarket.loanToken.decimals);
  const debtUsd = debtUsdg.multipliedBy(usdgPrice);
  const ltvPct = collateralUsd.isZero() ? BigNumber(0) : debtUsd.div(collateralUsd).multipliedBy(100);
  const stockNetUsd = collateralUsd.minus(debtUsd);
  const yieldNetUsd = loops.reduce(
    (t, p) => t.plus(p.amountLeveragedCollateral.multipliedBy(p.market.collateralTokenValueInLoanToken).minus(p.amountLoan).multipliedBy(p.market.loanToken.valueInUsd)),
    BigNumber(0),
  );
  const totalValueUsd = BigNumber.max(0, stockNetUsd.plus(yieldNetUsd));
  const depositedUsd = loops.reduce((t, p) => t.plus(vaultLoopDepositUsd(p, info)), BigNumber(0));
  const depositedUsdg = usdgPrice.isZero() ? depositedUsd : depositedUsd.div(usdgPrice);
  const stockLtv = ltvPct.toFixed(2);

  // Synthetic position for the STOCK leg, rendered through the standard open row (EquityPositionCard).
  const displayPos: AppPosition = {
    id: yieldPosition.id,
    open: true,
    userProxy: yieldPosition.userProxy,
    market: equityMarket,
    amountCollateral: collateral,
    amountCollateralInLoanToken: depositedUsdg,
    amountDepositedInLoanToken: depositedUsdg,
    amountReturnedInLoanToken: BigNumber(0),
    amountLeveragedCollateral: collateral,
    amountLoan: debtUsdg,
    ltv: stockLtv,
    liquidated: false,
    leverage: calcLeverage(stockLtv),
    leverageApy: info.netApyPct,
    incentiveAccruedUsd: 0,
    dbData: { ...yieldPosition.dbData, depositedUsd: depositedUsd.toNumber() },
    openedAt: yieldPosition.openedAt,
    row: yieldPosition.row,
  };
  const profitUsd = totalValueUsd.minus(depositedUsd);
  const y = getPositionYield(displayPos, profitUsd.toNumber());

  return {
    strategyId: equityMarket.morphoMarketId,
    chainId,
    userProxy: yieldPosition.userProxy,
    curator: info.curator,
    stockSymbol: stock.symbol,
    yieldSink,
    openedAt: yieldPosition.openedAt ?? null,
    netApyPct: info.netApyPct,
    apyBadge: `${info.netApyPct}% net APY`,
    yieldLoopIds: loops.map((p) => p.id),
    yieldLoopMatch: ev.yieldLoopMatch,
    ...(ev.ambiguousYieldLoopIds ? { ambiguousYieldLoopIds: ev.ambiguousYieldLoopIds } : {}),
    depositedUsd: str(depositedUsd),
    depositedUsdg: str(depositedUsdg),
    totalValueUsd: str(totalValueUsd),
    profitUsd: str(profitUsd),
    yieldLegUsd: str(totalValueUsd.minus(collateralUsd)),
    stock: {
      collateral: str(collateral),
      collateralUsd: str(collateralUsd),
      priceUsd: str(stock.valueInUsd),
      debtUsdg: str(debtUsdg),
      debtUsd: str(debtUsd),
      ltvPct: stockLtv,
      liqLtvPct: equityMarket.liqLtv,
      liquidationPriceUsd: str(BigNumber(stockLtv).dividedBy(BigNumber(equityMarket.liqLtv)).multipliedBy(stock.valueInUsd)),
      dropToLiquidationPct: ((1 - Number(stockLtv) / Number(equityMarket.liqLtv)) * 100).toFixed(1),
      borrowApyPct: info.stockBorrowApyPct,
    },
    market: marketView(equityMarket, chainId, collateralUsd.toNumber(), stock.symbol),
    view: openView(displayPos, { baseUsdOverride: profitUsd.toNumber(), hideLeverageBadge: true }),
    yield: yieldView(displayPos, y),
    dbDrift: [...new Set(loops.flatMap(driftOf))],
  };
}

// A closed vault has no on-chain footprint; its row's equityMarketId re-skins the closed card as the
// vault (utils/equityPosition.ts remapClosedEquityPositions). Only identity changes.
function remapClosedEquity(pos: AppPosition, vaults: Market[]): AppPosition {
  if (pos.open) return pos;
  const equityMarketId = pos.dbData?.equityMarketId;
  if (!equityMarketId) return pos;
  const equityMarket =
    vaults.find((m) => m.morphoMarketId.toLowerCase() === equityMarketId.toLowerCase()) ??
    vaults.find((m) => m.equityVault!.yieldMarketId.toLowerCase() === pos.market.morphoMarketId.toLowerCase());
  if (!equityMarket) return pos;
  const vaultMarket: Market = {
    ...equityMarket,
    collateralToken: {
      ...equityMarket.collateralToken,
      info: { ...equityMarket.collateralToken.info, project: equityMarket.collateralToken.symbol },
    },
  };
  return { ...pos, market: vaultMarket };
}

// ── wallet ────────────────────────────────────────────────────────────────────────────────────────
export interface WalletInputs {
  rows: PortfolioDbRow[]; // this wallet's dashboard rows on `chainId`
  nowMs?: number;
}

export async function buildWalletPortfolio(chainId: number, address: string, inputs: WalletInputs): Promise<WalletPortfolio> {
  const user = address.toLowerCase();
  const nowMs = inputs.nowMs ?? Date.now();
  const raw = await readUserPositionsRaw(chainId, user);
  const rowsByKey = new Map(inputs.rows.filter((r) => r.positionId).map((r) => [rowKey(r.positionId), r]));
  const tags = new Map<string, string>();
  for (const r of inputs.rows) if (r.positionId && r.equityMarketId) tags.set(r.positionId.toLowerCase(), r.equityMarketId.toLowerCase());

  const apps = raw.map((p) => calcAppPosition(p, rowsByKey.get(`${p.market.morphoMarketId.toLowerCase()}-${p.id}`), nowMs));
  const byId = new Map(apps.map((p) => [p.id, p]));

  // Vault attribution reuses the agent surface's resolver on the same chain read (no second RPC pass).
  const views = raw.map((p) => toPositionView(chainId, p)).reverse();
  const { equityPositions: equityViews } = await getUserEquityPositions(chainId, user, { positions: views, tags });
  const loops = composeSnapshot(chainId).markets.map((m) => m.market);
  const vaults = buildEquityMarkets(chainId, loops);

  const equityPositions: EquityPortfolioPosition[] = [];
  const claimed = new Set<number>();
  for (const ev of equityViews) {
    const equityMarket = vaults.find((m) => m.morphoMarketId.toLowerCase() === ev.strategyId.toLowerCase());
    const loopsOfVault = ev.yieldLoops.map((l) => byId.get(l.id)).filter((p): p is AppPosition => !!p);
    if (!equityMarket || loopsOfVault.length === 0) continue; // stock leg with no matching loop: loops stay plain
    loopsOfVault.forEach((p) => claimed.add(p.id));
    equityPositions.push(serializeEquity(ev, equityMarket, loopsOfVault, chainId));
  }

  // Newest first, matching the app (positions.reverse()).
  const ordered = [...apps].reverse();
  const openPlain = ordered.filter((p) => p.open && !p.liquidated && !claimed.has(p.id));
  const closedAll = ordered.filter((p) => !p.open || p.liquidated).map((p) => remapClosedEquity(p, vaults));

  // Header totals (Portfolio.tsx): every open card's deposit + each vault's deposit, each position once.
  const openCount = ordered.filter((p) => p.open && !p.liquidated).length - claimed.size + equityPositions.length;
  const totalDepositedUsd = openPlain
    .reduce((t, p) => t.plus(getDepositedUsd(p)), BigNumber(0))
    .plus(equityPositions.reduce((t, e) => t.plus(e.depositedUsd), BigNumber(0)));

  // Rows nothing on chain answers to.
  const chainKeys = new Set(apps.map((p) => `${p.market.morphoMarketId.toLowerCase()}-${p.id}`));
  const configured = new Set(loops.map((m) => m.morphoMarketId.toLowerCase()));
  const unresolved: UnresolvedRow[] = inputs.rows
    .filter((r) => r.positionId && !chainKeys.has(rowKey(r.positionId)))
    .map((row) => {
      const marketId = rowKey(row.positionId).split("-")[0] ?? "";
      const reason: UnresolvedRow["reason"] = configured.has(marketId)
        ? "no_chain_position"
        : configuredElsewhere(chainId, marketId)
          ? "chain_mismatch"
          : "market_not_configured";
      return { row, reason };
    });

  return {
    address: user,
    chainId,
    header: { totalDepositedUsd: str(totalDepositedUsd), openCount },
    positions: openPlain.map((p) => serializePosition(p, chainId)),
    equityPositions,
    closed: closedAll.map((p) => serializePosition(p, chainId)),
    unresolved,
  };
}

// Is `marketId` a configured market on a supported chain other than `chainId`? (Config only, no store.)
function configuredElsewhere(chainId: number, marketId: string): boolean {
  return SUPPORTED_CHAIN_IDS.some((c) => c !== chainId && readMarkets(c).some((m) => m.morphoMarketId.toLowerCase() === marketId));
}

export async function getWalletPortfolio(chainId: number, address: string): Promise<WalletPortfolio> {
  const rows = await fetchDashboardRows(chainId, address);
  return buildWalletPortfolio(chainId, address, { rows });
}

// ── every wallet (cached, coalesced) ──────────────────────────────────────────────────────────────
const WALLET_CONCURRENCY = 4;

async function computeAllPortfolios(chainId: number): Promise<PortfoliosPayload> {
  const [chainUsers, rows] = await Promise.all([discoverChainUsers(chainId), fetchDashboardRows(chainId)]);
  const rowsByUser = new Map<string, PortfolioDbRow[]>();
  for (const r of rows) {
    const u = r.user?.toLowerCase() ?? r.positionId?.split("-")[0]?.toLowerCase();
    if (!u) continue;
    (rowsByUser.get(u) ?? rowsByUser.set(u, []).get(u)!).push(r);
  }
  // A wallet that opened on chain (proxy scan) or that the dashboard knows about — the union, so a row
  // with nothing behind it on chain still surfaces (as `unresolved`) rather than vanishing.
  const users = [...new Set([...chainUsers.map((u) => u.toLowerCase()), ...rowsByUser.keys()])].sort();

  const wallets: WalletPortfolio[] = new Array(users.length);
  let next = 0;
  const worker = async () => {
    while (next < users.length) {
      const i = next++;
      const user = users[i]!;
      wallets[i] = await buildWalletPortfolio(chainId, user, { rows: rowsByUser.get(user) ?? [] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(WALLET_CONCURRENCY, users.length) }, worker));

  const counts = wallets.reduce(
    (c, w) => ({
      users: c.users + 1,
      open: c.open + w.positions.length,
      equity: c.equity + w.equityPositions.length,
      closed: c.closed + w.closed.length,
      unresolved: c.unresolved + w.unresolved.length,
      drift: c.drift + [...w.positions, ...w.closed, ...w.equityPositions].filter((p) => p.dbDrift.length > 0).length,
    }),
    { users: 0, open: 0, equity: 0, closed: 0, unresolved: 0, drift: 0 },
  );
  return { chainId, computedAt: new Date().toISOString(), users: wallets, counts };
}

const inflight = new Map<number, Promise<PortfoliosResponse>>();

function withFreshness(chainId: number): PortfoliosResponse | undefined {
  const view = rawStore.view<PortfoliosPayload>(KEYS.portfolio(chainId));
  if (!view) return undefined;
  return { ...view.value, asOf: view.asOf, stale: view.stale, degraded: view.degraded };
}

/**
 * Every wallet's portfolio on `chainId`. Served from the store while younger than the policy's
 * refresh window; otherwise recomputed once (concurrent callers share the computation). A failed
 * recompute serves last-good flagged `degraded`, or throws when there is nothing to serve yet.
 */
export async function getAllPortfolios(chainId: number): Promise<PortfoliosResponse> {
  const cached = withFreshness(chainId);
  if (cached && (Date.now() - new Date(cached.asOf).getTime()) / 1000 < POLICY.portfolio.refreshEverySec) return cached;

  let p = inflight.get(chainId);
  if (!p) {
    p = computeAllPortfolios(chainId)
      .then((payload) => {
        rawStore.setOk(KEYS.portfolio(chainId), payload, POLICY.portfolio.staleAfterSec);
        return withFreshness(chainId)!;
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        rawStore.setError(KEYS.portfolio(chainId), msg, POLICY.portfolio.staleAfterSec);
        log.warn("portfolio recompute failed", { chainId, error: msg });
        const last = withFreshness(chainId);
        if (last) return last;
        throw e;
      })
      .finally(() => inflight.delete(chainId));
    inflight.set(chainId, p);
  }
  return p;
}
