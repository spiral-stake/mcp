// ── The frozen `/strategies` wire contract (v1) ───────────────────────────────
// Mirrors mcp/CONTRACT.md exactly. This is the *external* shape agents/app/partners
// consume — distinct from the internal domain `Market` in ./index.ts.
//
// Conventions (see CONTRACT.md):
//  • APY/percent fields are 2-dp STRINGS suffixed `Pct`. USD amounts are numbers suffixed `Usd`.
//  • `null` = measured, no value. Field ABSENT = not measured (agent treats as unknown, not safe).
//  • Timestamps are ISO-8601 UTC strings.
//  • Additive-only evolution; breaking changes bump the version.

export type PctString = string; // 2-dp, e.g. "9.12"
export type IsoTimestamp = string; // ISO-8601 UTC

export interface FreshnessGroup {
  asOf: IsoTimestamp;
  staleAfterSec: number;
  /** Present and > 0 only when the group is being served past its staleAfterSec (last-good). */
  staleForSec?: number;
}

export interface StrategyCollateral {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  category: string; // stable | ETH | BTC | stable-PT | stocks | Nest RWA | Other
  project?: string;
  yieldSource?: string;
  priceUsd?: number;
  isPt: boolean;
  maturity: number | null;
  maturityDate: string | null;
  maturityDaysLeft: number | null;
  underlying?: { address: string; symbol: string };
}

export interface StrategyLoan {
  address: string;
  symbol: string;
  decimals: number;
  priceUsd?: number;
}

export interface BorrowIncentive {
  aprPct: PctString;
  breakdown: { symbol: string; aprPct: PctString }[];
  campaignUrl?: string; // absent when none
  endsAt?: IsoTimestamp; // absent if unknown
}

export interface LadderPoint {
  leverage: string; // e.g. "3.0"
  ltvPct: PctString; // e.g. "66.7"
  leverageApyPct: PctString;
}

export interface ExitLiquidity {
  measured: boolean;
  asOf?: IsoTimestamp;
  method?: string;
  direction?: string;
  // size(USD string) -> slippage %; a size is `null` when there is no route at that notional.
  slippagePct?: Record<string, PctString | null>;
}

export interface SpiralHints {
  exitLiquidityTier?: {
    value: string;
    thresholds: { listingMaxPct: number; depthCleanMaxPct: number };
  };
}

export interface Strategy {
  id: string;
  chainId: number;
  correlated: boolean;

  collateral: StrategyCollateral;
  loan: StrategyLoan;

  // yield facts (raw)
  collateralApyPct: PctString;
  collateralApySource: string; // pendle|defillama|royco|stablewatch|onchain
  yieldSustainabilityPct?: { avg30d?: PctString; avg60d?: PctString; avg90d?: PctString };

  // borrow facts (raw)
  borrowApyPct: PctString;
  quarterlyBorrowApyPct: PctString;
  borrowIncentive?: BorrowIncentive;
  netBorrowApyPct: PctString;

  // capacity facts (raw)
  supplyUsd: number;
  liquidityUsd: number;
  publicAllocatorLiquidityUsd: number;
  maxLeverage: string;
  utilizationPct?: PctString; // absent if not derivable

  // leverage ladder
  leverageLadder: LadderPoint[];
  defaultLeverage: LadderPoint;
  historicalLeverageApyPct?: { avg30d?: PctString; avg60d?: PctString; avg90d?: PctString };

  // risk facts (raw, NO verdicts)
  ltvPct: { liquidation: PctString; max: PctString };
  oracle: {
    address: string;
    type?: string; // nav | market
  };
  exitLiquidity: ExitLiquidity;
  noSwapRoute: boolean;

  // OPTIONAL Spiral opinion — namespaced + overridable
  spiralHints?: SpiralHints;

  // per-field-group freshness
  freshness: {
    borrow?: FreshnessGroup;
    collateralApy?: FreshnessGroup;
    exitLiquidity?: FreshnessGroup;
  };

  links?: { app?: string; market?: string; yieldSource?: string };
}

export interface StrategiesEnvelope {
  asOf: IsoTimestamp;
  chainId: number;
  count: number;
  strategies: Strategy[];
}
