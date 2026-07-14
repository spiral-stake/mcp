// Read-only leverage positions — ported from the app's getUserLeveragePositions, stripped to the
// on-chain-derivable facts. The app also reconciles against the dashboard DB (cost basis, realized
// P&L, earned incentives) and has recovery WRITE side-effects (registerOpen/ClosePosition); none of
// that belongs in the MCP. This reads chain state only and computes no-DB-needed metrics.
import BigNumber from "bignumber.js";
import { type Abi } from "viem";
import flashLeverageJson from "../abi/FlashLeverage.sol/FlashLeverage.json" with { type: "json" };
import { formatUnits } from "../core/formatUnits.ts";
import { calcLeverageApy } from "../core/leverage.ts";
import { composeSnapshot } from "../core/compose.ts";
import { readAddresses } from "../data/markets.ts";
import { getClient } from "../sources/onchain.ts";

const FLASH_LEVERAGE_ABI = (flashLeverageJson as { abi: Abi }).abi;

interface RawPosition {
  open: boolean;
  marketId: string;
  userProxy: string;
  amountDepositedInLoanToken: bigint;
  amountReturnedInLoanToken: bigint;
}

export interface LeveragePositionView {
  id: number; // index into the user's on-chain position array
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

    return {
      id,
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
    };
  });

  return views.reverse(); // newest first, matching the app
}
