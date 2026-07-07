import { CollateralTokenInfo } from "../types";

// Exit-liquidity verdict derived from the weekly exit-slippage snapshot
// (scripts/refresh-exit-slippage.mjs writes exitSlippage100k/500k/1M/5M onto CollateralTokenInfo).
// Each value is the % lost swapping collateral -> USDC at that notional; null = no route at
// that size; undefined = not measured yet.
//
// NOTE: keep the thresholds/logic here in sync with the verdict() helper in
// scripts/refresh-exit-slippage.mjs so the console report and the app agree.

// Max acceptable slippage at $100k for a token to be exitable at all. Above this it is
// effectively unswappable (a noSwapRoute candidate). Deliberately looser than the contract's
// 1% MAX_SLIPPAGE so tokens jittering around 1% aren't unlisted on quote variance.
export const LISTING_MAX_SLIPPAGE = 2; // %

// "Clean execution" bar for rating how large a swap stays cheap. A size counts toward a depth
// tier only when its slippage is below this. (Set below LISTING so a token that only squeaks
// under the listing gate at $100k reads "limited", not "deep".)
export const DEPTH_MAX_SLIPPAGE = 1.5; // %

export type ExitLiquidityTier = "deep" | "good" | "limited" | "thin" | "unknown";

type ExitSlippageFields = Pick<
  CollateralTokenInfo,
  "exitSlippage100k" | "exitSlippage500k" | "exitSlippage1M" | "exitSlippage5M"
>;

const clean = (v: number | null | undefined) => v != null && v < DEPTH_MAX_SLIPPAGE;

// Sizes below are the collateral->USDC swap notional, not a user's position/equity.
// deep   -> $1M+ swaps out cleanly
// good   -> ~$500k swaps out cleanly
// limited-> ~$100k swaps under the listing gate, but not cleanly at larger sizes
// thin   -> $100k can't swap under the listing gate (noSwapRoute candidate)
// unknown-> not measured yet
export function exitLiquidityTier(info?: ExitSlippageFields): ExitLiquidityTier {
  if (!info) return "unknown";
  const s100 = info.exitSlippage100k;
  if (s100 === undefined) return "unknown";

  // No route, or worse than the listing gate at $100k -> not safely exitable.
  if (s100 === null || s100 > LISTING_MAX_SLIPPAGE) return "thin";

  // Listed: rate by the largest size that still executes cleanly.
  if (clean(info.exitSlippage5M) || clean(info.exitSlippage1M)) return "deep";
  if (clean(info.exitSlippage500k)) return "good";
  return "limited";
}

// Largest swap notional that stays under the clean-execution bar, as a display string.
// Shown with a "+" since it's a floor ("at least this much exits cleanly").
// "" when nothing (down to $100k) is clean.
export function exitLiquiditySize(info?: ExitSlippageFields): string {
  if (!info) return "";
  if (clean(info.exitSlippage5M)) return "$5M+";
  if (clean(info.exitSlippage1M)) return "$1M+";
  if (clean(info.exitSlippage500k)) return "$500K+";
  if (clean(info.exitSlippage100k)) return "$100K+";
  return "";
}

// True when a token can't be safely exited at $100k, i.e. a candidate for noSwapRoute.
// Un-flagging stays a manual decision; a healthy reading is only a suggestion.
export function isExitThin(info?: ExitSlippageFields): boolean {
  return exitLiquidityTier(info) === "thin";
}

// Badge label + tooltip per tier. The concrete swap size comes from exitLiquiditySize().
export const EXIT_LIQUIDITY_META: Record<ExitLiquidityTier, { label: string; hint: string }> = {
  deep: {
    label: "Deep",
    hint: "Deep exit liquidity. Large amounts of collateral swap with minimal slippage.",
  },
  good: {
    label: "Good",
    hint: "Healthy exit liquidity. Mid-size amounts of collateral swap with minimal slippage.",
  },
  limited: {
    label: "Limited",
    hint: "Limited exit liquidity. Small amounts swap cleanly; larger sizes slip more.",
  },
  thin: {
    label: "Thin",
    hint: "Thin exit liquidity. Swapping collateral may incur high slippage.",
  },
  unknown: { label: "", hint: "Exit liquidity not measured yet." },
};
