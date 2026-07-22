import { CollateralTokenInfo } from "../types";

// Exit-liquidity verdict derived from the exit-slippage snapshot (exitSlippage100k/500k/1M/5M/10M on
// CollateralTokenInfo). Each value is the % lost swapping collateral -> the chain's stable at that
// notional; null = no route at that size; undefined = not measured yet.
//
// NOTE: this logic is DUPLICATED verbatim in the MCP (mcp/src/core/exitLiquidity.ts) and the app
// (v2-client/src/utils/exitLiquidity.ts). Keep them in sync so the agent hint (spiralHints) and the
// app badge label the same token identically.

// Max acceptable slippage at $100k for a token to be exitable at all. Above this it is effectively
// unswappable (a noSwapRoute candidate).
export const LISTING_MAX_SLIPPAGE = 2; // %

// "Clean execution" bar: a size counts toward a depth tier only when its slippage is below this.
export const DEPTH_MAX_SLIPPAGE = 1.5; // %

export type ExitLiquidityTier = "deep" | "good" | "limited" | "thin" | "unknown";

type ExitSlippageFields = Pick<
  CollateralTokenInfo,
  "exitSlippage100k" | "exitSlippage500k" | "exitSlippage1M" | "exitSlippage5M" | "exitSlippage10M"
>;

const clean = (v: number | null | undefined) => v != null && v < DEPTH_MAX_SLIPPAGE;

// Tier = the largest swap notional that still exits cleanly (< DEPTH_MAX_SLIPPAGE). Sizes are the
// collateral->stable swap notional, not a user's position/equity.
//   deep    -> $5M or $10M exits cleanly
//   good    -> $1M exits cleanly
//   limited -> $500k exits cleanly
//   thin    -> only $100k exits cleanly (or $100k can't clear the listing gate)
//   unknown -> not measured yet
export function exitLiquidityTier(info?: ExitSlippageFields): ExitLiquidityTier {
  if (!info) return "unknown";
  const s100 = info.exitSlippage100k;
  if (s100 === undefined) return "unknown";

  // No route, or worse than the listing gate at $100k -> not safely exitable.
  if (s100 === null || s100 > LISTING_MAX_SLIPPAGE) return "thin";

  if (clean(info.exitSlippage10M) || clean(info.exitSlippage5M)) return "deep";
  if (clean(info.exitSlippage1M)) return "good";
  if (clean(info.exitSlippage500k)) return "limited";
  return "thin";
}

// Largest swap notional that stays under the clean-execution bar, as a display string.
// Shown with a "+" since it's a floor ("at least this much exits cleanly"). "" when nothing is clean.
export function exitLiquiditySize(info?: ExitSlippageFields): string {
  if (!info) return "";
  if (clean(info.exitSlippage10M)) return "$10M+";
  if (clean(info.exitSlippage5M)) return "$5M+";
  if (clean(info.exitSlippage1M)) return "$1M+";
  if (clean(info.exitSlippage500k)) return "$500K+";
  if (clean(info.exitSlippage100k)) return "$100K+";
  return "";
}

// Numeric counterpart to exitLiquiditySize(): the largest swap notional (USD) that stays under the
// clean-execution bar, or 0 when nothing (down to $100k) is clean. Lets a caller compare a live
// position's unwind size against the depth that actually exits cleanly.
export function exitLiquidityCleanSizeUsd(info?: ExitSlippageFields): number {
  if (!info) return 0;
  if (clean(info.exitSlippage10M)) return 10_000_000;
  if (clean(info.exitSlippage5M)) return 5_000_000;
  if (clean(info.exitSlippage1M)) return 1_000_000;
  if (clean(info.exitSlippage500k)) return 500_000;
  if (clean(info.exitSlippage100k)) return 100_000;
  return 0;
}

// True when no route exists at $100k (null measurement), i.e. the market should be hidden from
// listings. Distinct from "thin" tier: a thin market has a route at $100k but can't exit cleanly
// above that size — it's still listed and shown.
export function isExitNoRoute(info?: ExitSlippageFields): boolean {
  return info?.exitSlippage100k === null;
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
    hint: "Deep exit liquidity — $5M+ of collateral swaps out with minimal slippage.",
  },
  good: {
    label: "Good",
    hint: "Healthy exit liquidity — ~$1M of collateral swaps out cleanly.",
  },
  limited: {
    label: "Limited",
    hint: "Limited exit liquidity — ~$500k swaps cleanly; larger sizes slip more.",
  },
  thin: {
    label: "Thin",
    hint: "Thin exit liquidity — even ~$100k may incur high slippage.",
  },
  unknown: { label: "", hint: "Exit liquidity not measured yet." },
};
