// Read-only leverage positions — ported from the app's getUserLeveragePositions, stripped to the
// on-chain-derivable facts. The app also reconciles against the dashboard DB (cost basis, realized
// P&L, earned incentives) and has recovery WRITE side-effects (registerOpen/ClosePosition); none of
// that belongs in the MCP. This reads chain state only and computes no-DB-needed metrics.
import BigNumber from "bignumber.js";
import { type Abi } from "viem";
import flashLeverageJson from "../abi/FlashLeverage.sol/FlashLeverage.json" with { type: "json" };
import { formatUnits } from "../core/formatUnits.ts";
import { calcLeverageApy } from "../core/leverage.ts";
import {
  exitLiquidityTier,
  exitLiquiditySize,
  exitLiquidityCleanSizeUsd,
  type ExitLiquidityTier,
} from "../core/exitLiquidity.ts";
import { composeSnapshot } from "../core/compose.ts";
import { readAddresses } from "../data/markets.ts";
import { getClient } from "../sources/onchain.ts";
import type { Market } from "../types/index.ts";

const FLASH_LEVERAGE_ABI = (flashLeverageJson as { abi: Abi }).abi;

interface RawPosition {
  open: boolean;
  marketId: string;
  userProxy: string;
  amountDepositedInLoanToken: bigint;
  amountReturnedInLoanToken: bigint;
}

export interface LeveragePositionView {
  id: number; // index into the user's on-chain position array (per chain+contract — NOT globally unique)
  positionId: string; // globally-unique composite: `${chainId}-${strategyId}-${id}` (safe to merge across chains)
  chainId: number;
  strategyId: string; // morpho market id
  open: boolean;
  liquidated: boolean;
  collateralSymbol: string;
  loanSymbol: string;
  amountLeveragedCollateral: string; // total collateral backing the position
  netCollateral: string; // user's equity expressed in collateral units
  amountLoan: string; // outstanding debt in loan-token units
  ltvPct: string;
  liquidationLtvPct: string;
  ltvHeadroomPct: string; // liquidationLtv - ltv (negative ⇒ liquidatable)
  currentLeverage: string;
  netValueUsd: string; // equity value in USD
  currentLeverageApyPct: string; // leveraged APY at the position's current LTV
  // Can this position actually be unwound? A one-shot close swaps the FULL leveraged collateral,
  // so the notional that matters is the whole position, not the user's equity. Surfaced per
  // position so a holder (or a monitoring agent) sees the exit degrading before close stops
  // working — `close` fails closed when the route is gone, but by then it's too late to plan.
  // Escape hatch when exit liquidity dries up: `repay` (in the loan token) + `remove_collateral`
  // both need NO swap route, so the collateral can always be withdrawn in-kind.
  exitLiquidity: {
    tier: ExitLiquidityTier; // deep | good | limited | thin | unknown
    cleanExitSize: string; // largest notional that exits cleanly, e.g. "$1M+" ("" = none)
    unwindSizeUsd: number; // this position's full unwind notional
    exceedsCleanExitSize: boolean; // unwind size > what exits cleanly ⇒ expect slippage on close
    noSwapRoute: boolean; // hard flag: collateral is currently unswappable
  };
}

// Current state of a single position, for the manage/close builders. Reads the on-chain position
// (index `id`), its Morpho collateral+debt, and resolves the configured market.
export interface ManagePosition {
  market: Market;
  open: boolean;
  collateralRaw: bigint; // collateral in token units (for the full-close swap)
  borrowShares: bigint;
  amountLeveragedCollateral: BigNumber; // human units — for increase-leverage sizing
  amountLoan: BigNumber; // human units
}

export async function readManagePosition(chainId: number, user: string, id: number): Promise<ManagePosition> {
  const flashLeverageAddress = readAddresses(chainId).flashLeverageAddress as `0x${string}`;
  const client = getClient(chainId);

  const raw = (await client.readContract({
    abi: FLASH_LEVERAGE_ABI,
    address: flashLeverageAddress,
    functionName: "getUserLeveragePosition",
    args: [user, BigInt(id)],
  })) as { open: boolean; marketId: string; userProxy: string };

  const market = composeSnapshot(chainId).markets.map((m) => m.market).find((m) => m.morphoMarketId === raw.marketId);
  if (!market) throw new Error(`Position ${id}: market ${raw.marketId} is not configured`);

  const mp = (await client.readContract({
    abi: FLASH_LEVERAGE_ABI,
    address: flashLeverageAddress,
    functionName: "getMorphoPosition",
    args: [raw.userProxy, market.marketParams],
  })) as { borrowShares: bigint; collateral: bigint };

  const loanRaw = (await client.readContract({
    abi: FLASH_LEVERAGE_ABI,
    address: flashLeverageAddress,
    functionName: "getSharesValueInLoanToken",
    args: [market.marketParams, mp.borrowShares],
  })) as bigint;

  return {
    market,
    open: raw.open,
    collateralRaw: mp.collateral,
    borrowShares: mp.borrowShares,
    amountLeveragedCollateral: formatUnits(mp.collateral, market.collateralToken.decimals),
    amountLoan: formatUnits(loanRaw, market.loanToken.decimals),
  };
}

export async function getUserPositions(chainId: number, user: string): Promise<LeveragePositionView[]> {
  const flashLeverageAddress = readAddresses(chainId).flashLeverageAddress as `0x${string}`;
  const client = getClient(chainId);

  const raw = (await client.readContract({
    abi: FLASH_LEVERAGE_ABI,
    address: flashLeverageAddress,
    functionName: "getUserLeveragePositions",
    args: [user],
  })) as RawPosition[];
  if (raw.length === 0) return [];

  // Pair each position with its configured market; skip any whose market is no longer configured.
  const markets = composeSnapshot(chainId).markets.map((m) => m.market);
  const pairs = raw
    .map((pos, id) => ({ pos, id, market: markets.find((m) => m.morphoMarketId === pos.marketId) }))
    .filter((e): e is { pos: RawPosition; id: number; market: (typeof markets)[number] } => e.market !== undefined);
  if (pairs.length === 0) return [];

  // Two multicall rounds: the Morpho position (shares + collateral), then debt shares -> loan units.
  const morphoPositions = (await client.multicall({
    contracts: pairs.map((e) => ({
      abi: FLASH_LEVERAGE_ABI,
      address: flashLeverageAddress,
      functionName: "getMorphoPosition",
      args: [e.pos.userProxy, e.market.marketParams],
    })),
    allowFailure: false,
  })) as unknown as { borrowShares: bigint; collateral: bigint }[];

  const loanRaw = (await client.multicall({
    contracts: pairs.map((e, i) => ({
      abi: FLASH_LEVERAGE_ABI,
      address: flashLeverageAddress,
      functionName: "getSharesValueInLoanToken",
      args: [e.market.marketParams, morphoPositions[i]?.borrowShares ?? 0n],
    })),
    allowFailure: false,
  })) as unknown as bigint[];

  const views = pairs.map(({ pos, id, market }, i) => {
    const mp = morphoPositions[i] ?? { borrowShares: 0n, collateral: 0n };
    const price = market.collateralTokenValueInLoanToken; // collateral -> loan units
    const amountLeveragedCollateral = formatUnits(mp.collateral, market.collateralToken.decimals);
    const amountLoan = formatUnits(loanRaw[i] ?? 0n, market.loanToken.decimals);

    const leveragedInLoan = amountLeveragedCollateral.multipliedBy(price);
    const equityInLoan = leveragedInLoan.minus(amountLoan);
    const netCollateral = price.isZero() ? BigNumber(0) : amountLeveragedCollateral.minus(amountLoan.div(price));
    const ltv = leveragedInLoan.isZero() ? BigNumber(0) : amountLoan.multipliedBy(100).div(leveragedInLoan);
    const currentLeverage = equityInLoan.isZero() ? BigNumber(0) : leveragedInLoan.div(equityInLoan);
    const liquidated = pos.open && amountLeveragedCollateral.isZero();
    const netBorrowApy = BigNumber(market.borrowApy).minus(market.borrowIncentiveApy).toFixed(2);

    // Exit health for THIS position: a one-shot close swaps the full leveraged collateral, so the
    // notional to compare against the market's clean-exit depth is the whole position, not equity.
    const info = market.collateralToken.info;
    const unwindSizeUsd = amountLeveragedCollateral
      .multipliedBy(market.collateralToken.valueInUsd)
      .toNumber();
    const cleanSizeUsd = exitLiquidityCleanSizeUsd(info);

    return {
      id,
      positionId: `${chainId}-${market.morphoMarketId}-${id}`,
      chainId,
      strategyId: market.morphoMarketId,
      open: pos.open,
      liquidated,
      collateralSymbol: market.collateralToken.symbol,
      loanSymbol: market.loanToken.symbol,
      amountLeveragedCollateral: amountLeveragedCollateral.toFixed(6, BigNumber.ROUND_DOWN),
      netCollateral: netCollateral.toFixed(6, BigNumber.ROUND_DOWN),
      amountLoan: amountLoan.toFixed(6, BigNumber.ROUND_DOWN),
      ltvPct: ltv.toFixed(2),
      liquidationLtvPct: BigNumber(market.liqLtv).toFixed(2),
      ltvHeadroomPct: BigNumber(market.liqLtv).minus(ltv).toFixed(2),
      currentLeverage: currentLeverage.toFixed(2),
      netValueUsd: equityInLoan.multipliedBy(market.loanToken.valueInUsd).toFixed(2),
      currentLeverageApyPct: calcLeverageApy(market.correlated, market.collateralToken.apy, netBorrowApy, ltv.toFixed(2)),
      exitLiquidity: {
        tier: exitLiquidityTier(info),
        cleanExitSize: exitLiquiditySize(info),
        unwindSizeUsd: Number(unwindSizeUsd.toFixed(2)),
        exceedsCleanExitSize: unwindSizeUsd > cleanSizeUsd,
        noSwapRoute: !!info?.noSwapRoute,
      },
    };
  });

  return views.reverse(); // newest first, matching the app
}
