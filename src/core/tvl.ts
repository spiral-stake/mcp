// Protocol TVL — pure aggregation over valued positions (no I/O). Mirrors the DefiLlama adapter
// (listings/defillama/projects/spiral-stake): every open Spiral position is a UserProxy holding
// Morpho collateral + debt, so
//
//   grossTvlUsd = Σ collateral value      (total looped collateral)
//   borrowedUsd = Σ debt                  (owed to Morpho)
//   tvlUsd      = gross − borrowed        (net user equity — the DefiLlama "tvl")
//
// Only the user's own margin is new value in Morpho (the leveraged part is flash-borrowed and
// repaid out of the Morpho borrow), which is why the headline figure is net of debt. The chain
// reads live in sources/tvl.ts; this module is what the offline test exercises.
import BigNumber from "bignumber.js";

export interface TvlTotals {
  tvlUsd: number; // net user equity = grossTvlUsd − borrowedUsd (2 decimals)
  grossTvlUsd: number; // total looped collateral (2 decimals)
  borrowedUsd: number; // total debt (2 decimals)
  positions: number; // open positions with non-zero collateral
  users: number; // distinct users with at least one such position
}

export interface ChainTvl extends TvlTotals {
  chainId: number;
}

export interface ChainTvlEntry extends ChainTvl {
  asOf: string;
  stale: boolean;
}

export interface TvlResponse {
  asOf: string; // oldest chain snapshot
  stale: boolean; // any chain stale
  total: TvlTotals;
  chains: ChainTvlEntry[];
}

// One open position with non-zero collateral, already converted to loan-token units.
export interface ValuedPosition {
  user: string;
  collateralValueInLoan: BigNumber; // human loan-token units
  debtInLoan: BigNumber; // human loan-token units
  loanPriceUsd: BigNumber; // USD per loan token, already sanity-clamped
}

// Loan-price sanity band. Spiral's loan tokens are (almost all) stablecoins, so a feed outside
// this band is a broken feed, not a market move — one once printed $84M of debt on dust
// positions. Anything outside is coerced to $1 (the app's own "unpriced" default). Tokens whose
// price legitimately lives outside the band (ETH/BTC-class loan tokens) are exempted by the caller.
export const LOAN_PRICE_MIN = 0.05;
export const LOAN_PRICE_MAX = 2.0;

export function clampLoanPrice(price: BigNumber | number | string | undefined, exempt = false): BigNumber {
  if (price === undefined || price === null) return new BigNumber(1);
  const p = price instanceof BigNumber ? price : new BigNumber(price);
  if (!p.isFinite() || p.lte(0)) return new BigNumber(1);
  if (exempt) return p;
  if (p.lt(LOAN_PRICE_MIN) || p.gt(LOAN_PRICE_MAX)) return new BigNumber(1);
  return p;
}

// Morpho Blue oracle convention: price() is scaled by 1e36 and already carries the
// 10^(loanDecimals − collateralDecimals) adjustment, so
//   loanRaw = collateralRaw · price / 1e36
// yields raw loan-token units directly. Used for markets that are no longer configured.
export const ORACLE_PRICE_SCALE = 10n ** 36n;

export function collateralValueViaOracle(collateralRaw: bigint, oraclePrice: bigint, loanDecimals: number): BigNumber {
  const loanRaw = (collateralRaw * oraclePrice) / ORACLE_PRICE_SCALE;
  return new BigNumber(loanRaw.toString()).shiftedBy(-loanDecimals);
}

const usd2 = (x: BigNumber): number => Number(x.toFixed(2, BigNumber.ROUND_HALF_UP));

export function sumChainTvl(chainId: number, positions: ValuedPosition[]): ChainTvl {
  let gross = new BigNumber(0);
  let borrowed = new BigNumber(0);
  const users = new Set<string>();
  for (const p of positions) {
    gross = gross.plus(p.collateralValueInLoan.multipliedBy(p.loanPriceUsd));
    borrowed = borrowed.plus(p.debtInLoan.multipliedBy(p.loanPriceUsd));
    users.add(p.user.toLowerCase());
  }
  // Round gross and borrowed first, then derive net from the ROUNDED figures so the identity
  // tvlUsd + borrowedUsd = grossTvlUsd holds to the cent in the served JSON.
  const grossUsd = usd2(gross);
  const borrowedUsd = usd2(borrowed);
  const tvlUsd = usd2(new BigNumber(grossUsd).minus(borrowedUsd));
  return { chainId, tvlUsd, grossTvlUsd: grossUsd, borrowedUsd, positions: positions.length, users: users.size };
}

export function aggregateTvl(chains: ChainTvlEntry[]): TvlResponse {
  if (chains.length === 0) throw new Error("aggregateTvl: no chains");
  let tvl = new BigNumber(0);
  let gross = new BigNumber(0);
  let borrowed = new BigNumber(0);
  let positions = 0;
  let users = 0;
  let asOf = chains[0].asOf;
  let stale = false;
  for (const c of chains) {
    tvl = tvl.plus(c.tvlUsd);
    gross = gross.plus(c.grossTvlUsd);
    borrowed = borrowed.plus(c.borrowedUsd);
    positions += c.positions;
    users += c.users; // per-chain distinct; a wallet active on two chains counts once per chain
    if (c.asOf < asOf) asOf = c.asOf; // ISO-8601 sorts lexically
    stale = stale || c.stale;
  }
  return {
    asOf,
    stale,
    total: { tvlUsd: usd2(tvl), grossTvlUsd: usd2(gross), borrowedUsd: usd2(borrowed), positions, users },
    chains,
  };
}
