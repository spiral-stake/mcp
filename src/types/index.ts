// Domain model — ported verbatim from v2-client/src/types/index.ts (the shapes the copied
// `core/leverage.ts`, `core/pt.ts`, `core/exitLiquidity.ts` and the composition depend on).
// This is the *internal* model. The frozen external wire contract lives in `types/contract.ts`.
import BigNumber from "bignumber.js";

// Daily borrow-incentive APR snapshot from Merkl (%). Defined here to avoid a source→type
// dependency cycle; mirrors sources/merkl.ts.
export interface MerklAprRecord {
  ts: number;
  apr: number;
}

export enum TokenCategory {
  ETH = "ETH",
  BTC = "BTC",
  Stable = "stable",
  StablePT = "stable-PT",
  Stocks = "stocks",
  NestRWA = "Nest RWA",
  Hype = "hype",
  Other = "Other",
}

export interface Token {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  valueInUsd: BigNumber;
  coingeckoId?: string;
}

export interface CollateralToken extends Token {
  apy: string;
  info: CollateralTokenInfo;

  // PT specific
  isPt: boolean;
  symbolExtended?: string;
  maturity?: number;
  maturityDate?: string;
  maturityDaysLeft?: number;
  underlying?: Token;
}

export interface Market {
  morphoMarketId: string;
  correlated: boolean;
  collateralToken: CollateralToken;
  loanToken: Token;
  borrowApy: string;
  quarterlyBorrowApy: string;
  borrowIncentiveApy: string;
  borrowIncentiveBreakdown: { symbol: string; apy: string }[];
  borrowIncentiveUrl?: string;
  borrowIncentiveHistory: MerklAprRecord[];
  collateralIncentiveHistory: MerklAprRecord[];
  // Collateral-side Merkl incentive (MORPHOCOLLATERAL) — extra yield on the supplied collateral.
  collateralIncentiveApy: string;
  collateralIncentiveBreakdown: { symbol: string; apy: string }[];
  collateralIncentiveUrl?: string;
  collateralTokenValueInLoanToken: BigNumber;
  loanTokenValueInCollateralToken: BigNumber;
  supplyAssets: BigNumber;
  supplyAssetsUsd: number;
  liquidityAssetsParsed: bigint;
  liquidityAssets: BigNumber;
  liquidityAssetsUsd: number;
  paLiquidityAssets: BigNumber;
  paSharedLiquidity: SharedLiquidityRaw[];
  liqLtv: string;
  maxLtv: string;
  safeLtv: string; // set internally
  // Eligibility, computed in compose (mirrors the app's filterMarkets). The agent endpoint
  // (/v1/strategies) serves only visible markets; /v1/app/markets serves all (with this flag) so
  // the app can still resolve a portfolio position on an ineligible market. Undefined pre-compose.
  visible?: boolean;
  defaultLeverage: string;
  defaultLeverageApy: string;
  avg30dLeverageApy?: string;
  avg60dLeverageApy?: string;
  avg90dLeverageApy?: string;
  oracle: string;
  irm: string;
  marketParams: MarketParams;
  oracleType?: OracleType;
  // Morpho V2 vault curators supplying this market, deduped and capped to the top 2 by their
  // largest supplying vault's TVL. Sourced in sources/morpho.ts, display-only. undefined = the
  // market has no curated V2 vault supply (renders nothing in the app).
  curators?: MarketCurator[];
  // Present ONLY on synthetic equity-vault strategies (see data/equityVaults.ts, core/equity.ts).
  // Its presence is the discriminator: the app renders the equity card/copy and runs the composite
  // open (swap→stock collateral→borrow USDG→yield loop) instead of the standard single-market loop.
  equityVault?: EquityVaultInfo;
}

// The composite config + live economics of an equity vault, carried on the synthetic Market/Strategy.
export interface EquityVaultInfo {
  stockMarketId: string; // external Morpho market: stock collateral / USDG loan
  targetLtvPct: string; // borrow ratio on the stock leg
  liqLtvPct: string; // stock market LLTV (liquidation threshold)
  yieldMarketId: string; // Spiral yield-loop market the borrowed USDG is deployed into
  yieldLeverage: string; // leverage applied on the yield loop
  yieldLegApyPct: string; // live leveraged APY of the yield loop
  stockBorrowApyPct: string; // live USDG borrow APR on the stock market
  netApyPct: string; // = (targetLtv/100) x (yieldLegApy - stockBorrowApy); live, can be negative
  stockPriceUsd: string; // live stock price
  // The client needs these to encode the Leg-1 Morpho calls directly — the synthetic Market's own
  // `marketParams` are the yield market's (cloned), NOT the stock market's.
  morpho: string; // Morpho singleton on this chain
  stockMarketParams: { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string };
}

export interface MarketCurator {
  name: string;
  image: string;
  // The curator's largest V2 vault supplying this market (name + vault TVL in USD). One-element
  // array kept for shape flexibility, but only the top vault per curator is surfaced.
  vaults: { name: string; totalAssetsUsd: number }[];
}

export type OracleType = "nav" | "market";

export interface MarketParams {
  collateralToken: string;
  loanToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

// Public-allocator reallocation (execution). Mirrors the app's types.
export interface Withdrawal {
  marketParams: MarketParams;
  amount: bigint;
}
export interface ReallocateParams {
  vault: string;
  fee: bigint;
  withdrawals: Withdrawal[];
  supplyMarketParams: MarketParams;
}

export interface LeveragePosition {
  id: number;
  open: boolean;
  owner: string;
  market: Market;
  amountCollateral: BigNumber;
  amountCollateralInLoanToken: BigNumber;
  userProxy: string;
  amountDepositedInLoanToken: BigNumber;
  amountReturnedInLoanToken: BigNumber;
  amountLeveragedCollateral: BigNumber;
  borrowShares: bigint;
  amountLoan: BigNumber;
  ltv: string;
  liquidated: boolean;
  leverage: string;
  leverageApy: string;
  yieldGenerated: BigNumber;
  openedAt?: string;
  dbData?: {
    depositedUsd: number;
    returnedUsd?: number;
    yieldUsd?: number;
    incentiveUsd?: number;
  };
}

export interface SharedLiquidityRaw {
  withdrawMarket: {
    marketId: string;
  };
  assets: string | number;
  vault: {
    address: string;
    name: string;
    publicAllocatorConfig: { fee: string | number } | null;
  };
}

export interface CollateralTokenInfo {
  project: string;
  underlyingCollateral: string;
  yieldSource: string;
  category: TokenCategory;
  noSwapRoute?: Boolean;

  exitSlippage100k?: number | null;
  exitSlippage500k?: number | null;
  exitSlippage1M?: number | null;
  exitSlippage5M?: number | null;
  exitSlippage10M?: number | null;

  defaultLeverageApyDay?: number;

  defillamaId?: string;
  coingeckoId?: string;
  stablewatchId?: string;
  royco?: boolean;
  tradingViewSymbol?: string;

  description?: string;
  website?: string;
  twitter?: string;
}

export interface LoanTokenInfo {
  coingeckoId?: string;
}
