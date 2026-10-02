// Which chains this instance serves. One deployment serves every supported chain from a single
// host, selected per request via ?chainId (default = the primary). A chain is enabled when its RPC
// is configured, so a production instance opts into Robinhood simply by setting ROBINHOOD_RPC_URL.
import { env } from "./env.ts";

export const ROBINHOOD_CHAIN_ID = 4663;

// Least borrowable liquidity a market must have to be listed. Robinhood has its own (lower) floor:
// its markets are young and thin, but a market with nothing to borrow cannot be opened at all.
export const minBorrowableUsd = (chainId: number): number =>
  chainId === ROBINHOOD_CHAIN_ID ? env.ROBINHOOD_MIN_BORROWABLE_USD : env.MIN_BORROWABLE_USD;

// The default chain when a request omits ?chainId. Always supported.
export const PRIMARY_CHAIN_ID = env.CHAIN_ID;

export const SUPPORTED_CHAIN_IDS: number[] = (() => {
  const ids = new Set<number>([PRIMARY_CHAIN_ID]);
  if (env.ROBINHOOD_RPC_URL) ids.add(ROBINHOOD_CHAIN_ID);
  return [...ids];
})();

export const isSupportedChain = (id: number): boolean => SUPPORTED_CHAIN_IDS.includes(id);
