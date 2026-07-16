// Historical/averaged leveraged-APY helpers — ported verbatim (logic) from
// v2-client/src/contract-hooks/FlashLeverage.ts (avgCollateralApyOverDays, computeAvgLeverageApy).
// These feed the live default APY smoothing and the 30/60/90d windows. Kept identical so the
// parity gate holds.
import BigNumber from "bignumber.js";
import { Market } from "../types/index.ts";
import { calcLeverageApy } from "./leverage.ts";
import { incentiveAprAt, type MerklAprRecord } from "../sources/merkl.ts";
import type { ApyHistoryPoint } from "./apy.ts";
import type { BorrowHistoryPoint } from "../sources/morpho.ts";

// Trailing N-day average of the collateral APY history. Used for lumpy-distribution tokens
// (defaultLeverageApyDay), where spot APY is unrepresentative. Falls back to spot when empty.
export function avgCollateralApyOverDays(
  apyHistory: ApyHistoryPoint[],
  days: number,
  fallbackApy: string,
): string {
  const cutoff = Date.now() - days * 86_400_000;
  const vals = apyHistory.filter((r) => r.ts >= cutoff).map((r) => r.apy);
  if (vals.length === 0) return fallbackApy;
  return (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2);
}

export function computeAvgLeverageApy(
  apyHistory: ApyHistoryPoint[],
  borrowHistory: BorrowHistoryPoint[],
  incentiveHistory: MerklAprRecord[],
  collateralIncentiveHistory: MerklAprRecord[],
  days: number,
  market: Market,
): string | undefined {
  // Return undefined when the token hasn't been live for ~the full window (average would be
  // dominated by pre-inception 0% placeholders) — the app renders "-" in that case.
  const liveSinceTs = apyHistory.reduce<number | null>(
    (min, r) => (r.apy > 0 && (min === null || r.ts < min) ? r.ts : min),
    null,
  );
  const graceMs = 3 * 86_400_000;
  if (liveSinceTs !== null && Date.now() - liveSinceTs < days * 86_400_000 - graceMs) {
    return undefined;
  }

  const cutoff = Date.now() - days * 86_400_000;
  // Each APY point is lifted by the collateral incentive active at that timestamp.
  const apyVals = apyHistory
    .filter((r) => r.ts >= cutoff)
    .map((r) => r.apy + incentiveAprAt(collateralIncentiveHistory, r.ts));
  const netBorrowVals = borrowHistory
    .filter((p) => p.x * 1000 >= cutoff)
    .map((p) => p.y * 100 - incentiveAprAt(incentiveHistory, p.x * 1000));
  const avgCollateralApy =
    apyVals.length > 0
      ? (apyVals.reduce((s, v) => s + v, 0) / apyVals.length).toFixed(2)
      : BigNumber(market.collateralToken.apy).plus(market.collateralIncentiveApy).toFixed(2);
  const avgBorrowApy =
    netBorrowVals.length > 0
      ? (netBorrowVals.reduce((s, v) => s + v, 0) / netBorrowVals.length).toFixed(2)
      : BigNumber(market.borrowApy).minus(market.borrowIncentiveApy).toFixed(2);
  return calcLeverageApy(market.correlated, avgCollateralApy, avgBorrowApy, market.safeLtv);
}
