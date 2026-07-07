import BigNumber from "bignumber.js";
import { parseUnits } from "./formatUnits";
import { Market, LeveragePosition } from "../types";

export function calcLtv(
  amountCollateral: BigNumber,
  amountLoan: BigNumber,
  collateralTokenValueInLoanToken: BigNumber,
) {
  const ltv = amountLoan
    .div(amountCollateral.multipliedBy(collateralTokenValueInLoanToken))
    .multipliedBy(100);
  return ltv.isNaN() || !ltv.isFinite() ? "0.00" : ltv.toFixed(2);
}

export function calcLeverage(desiredLtv: string) {
  const maxLeverage = BigNumber(100).dividedBy(BigNumber(100).minus(BigNumber(desiredLtv)));
  return maxLeverage.isNaN() || !maxLeverage.isFinite() ? "1.0" : maxLeverage.toFixed(1);
}

export function calcLeverageApy(
  correlated: boolean,
  collateralTokenApy: string,
  borrowApy: string,
  desiredLtv: string,
) {
  const leverage = calcLeverage(desiredLtv);

  return BigNumber(collateralTokenApy)
    .multipliedBy(BigNumber(leverage))
    .minus(BigNumber(borrowApy).multipliedBy(BigNumber(leverage).minus(1)))
    .multipliedBy(correlated ? 1 : -1)
    .toFixed(2);
}

export function calcFlashLoanAmount(desiredLtv: string, market: Market, amountCollateral: string) {
  const collateralValue = market.collateralTokenValueInLoanToken.multipliedBy(amountCollateral);
  const ltv = BigNumber(desiredLtv).div(100); // in percentage

  // Total position value = collateralValue / (1 - LTV)
  const totalPositionValue = collateralValue.div(BigNumber(1).minus(ltv));

  // toFixed (not toString) — toString emits exponential notation for values
  // < 1e-7, which viem's parseUnits rejects.
  return parseUnits(
    totalPositionValue.minus(collateralValue).toFixed(market.loanToken.decimals, BigNumber.ROUND_DOWN),
    market.loanToken.decimals,
  );
}

export function calcIncreaseLeverageFlashLoanAmount(
  desiredLtv: string,
  position: LeveragePosition,
): bigint {
  const { amountLeveragedCollateral, amountLoan, market } = position;
  const ltv = BigNumber(desiredLtv).div(100);

  // f = (desiredLtv * C*P - L) / (1 - desiredLtv)
  const collateralValue = amountLeveragedCollateral.multipliedBy(
    market.collateralTokenValueInLoanToken,
  );
  const numerator = ltv.multipliedBy(collateralValue).minus(amountLoan);
  const denominator = BigNumber(1).minus(ltv);
  const flashLoanAmount = numerator.div(denominator);

  if (flashLoanAmount.isNegative() || flashLoanAmount.isZero()) return BigInt(0);

  return parseUnits(
    flashLoanAmount.toFixed(market.loanToken.decimals, BigNumber.ROUND_DOWN),
    market.loanToken.decimals,
  );
}

// Returns the additional collateral (in loan-token / USD terms) needed to reach desiredLtv.
// Supplying collateral keeps the loan fixed: newCollateralUsd = loan / (desiredLtv / 100)
export function calcSupplyCollateralUsdFromLtv(
  desiredLtv: string,
  position: LeveragePosition,
): BigNumber {
  const { amountLeveragedCollateral, amountLoan, market } = position;
  const ltv = BigNumber(desiredLtv).div(100);
  if (ltv.isZero()) return BigNumber(0);
  const currentCollateralUsd = amountLeveragedCollateral.multipliedBy(
    market.collateralTokenValueInLoanToken,
  );
  const targetCollateralUsd = amountLoan.div(ltv);
  const delta = targetCollateralUsd.minus(currentCollateralUsd);
  return delta.isNegative() ? BigNumber(0) : delta;
}

// Returns the resulting LTV (%) after supplying supplyCollateralUsd of additional collateral.
// Loan stays fixed; only the collateral side grows.
export function calcLtvFromSupplyCollateralUsd(
  supplyCollateralUsd: BigNumber,
  position: LeveragePosition,
): string {
  const { amountLeveragedCollateral, amountLoan, market } = position;
  const currentCollateralUsd = amountLeveragedCollateral.multipliedBy(
    market.collateralTokenValueInLoanToken,
  );
  const newCollateralUsd = currentCollateralUsd.plus(supplyCollateralUsd);
  if (newCollateralUsd.isZero()) return "0.00";
  const ltv = amountLoan.div(newCollateralUsd).multipliedBy(100);
  return ltv.isNaN() || !ltv.isFinite() ? "0.00" : ltv.toFixed(2);
}

export function calcMaxLeverageAmount(desiredLtv: string, market: Market) {
  const ltv = BigNumber(desiredLtv).div(100);
  // Use combined PA liquidity (direct + public-allocator shared) so the guard
  // matches what the reallocate path can actually support.
  const flashLoanAmount = market.paLiquidityAssets;

  // From the flash loan function: flashLoan = collateralValue * LTV / (1 - LTV)
  // So: collateralValue = flashLoan * (1 - LTV) / LTV
  const collateralValueInLoanToken = BigNumber(flashLoanAmount)
    .multipliedBy(BigNumber(1).minus(ltv))
    .div(ltv);

  // Convert from loan token terms to collateral token terms
  const collateralAmount = collateralValueInLoanToken.div(market.collateralTokenValueInLoanToken);

  // Subtract buffer to avoid edge cases with rounding/slippage
  return collateralAmount;
}
