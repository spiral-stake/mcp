// Warming/freshness policy — the single source of truth for cadences and staleness budgets,
// aligned to CONTRACT.md § "Refresh cadence (producer)".
//
//   • refreshEverySec — how often the background warmer re-fetches the upstream.
//   • staleAfterSec   — when a consumer should treat the value as stale (drives `freshness`).
//
// Reads never fetch: they serve whatever the warmer last wrote (last-good), with the stale age
// made visible. staleAfterSec is deliberately >= refreshEverySec so a single missed refresh
// doesn't immediately flip a group to stale.

export interface WarmPolicy {
  refreshEverySec: number;
  staleAfterSec: number;
}

const M = 60;
const H = 60 * 60;

export const POLICY = {
  // Borrow APY + liquidity + public-allocator depth (Morpho GraphQL).
  morphoMarkets: { refreshEverySec: 2 * M, staleAfterSec: 5 * M } satisfies WarmPolicy,
  // Borrow-APY history (charts + 30/60/90d windows).
  morphoBorrowHistory: { refreshEverySec: 30 * M, staleAfterSec: 60 * M } satisfies WarmPolicy,

  // Collateral APY — non-PT (StableWatch direct, DeFiLlama, Royco, on-chain).
  stablewatchApy: { refreshEverySec: 12 * H, staleAfterSec: 12 * H } satisfies WarmPolicy,
  defillama: { refreshEverySec: 12 * H, staleAfterSec: 12 * H } satisfies WarmPolicy,
  royco: { refreshEverySec: 12 * H, staleAfterSec: 12 * H } satisfies WarmPolicy,
  onchainApy: { refreshEverySec: 12 * H, staleAfterSec: 12 * H } satisfies WarmPolicy,
  // Collateral APY — Pendle PT (implied APY): faster cadence.
  pendle: { refreshEverySec: 30 * M, staleAfterSec: 30 * M } satisfies WarmPolicy,

  // Borrow incentives (Merkl): spot + daily APR history.
  merkl: { refreshEverySec: 30 * M, staleAfterSec: 60 * M } satisfies WarmPolicy,

  // Token/loan prices (CoinGecko). Loan tokens are mostly stablecoins (~$1) that barely move, and
  // the CoinGecko demo key is rate-capped — so refresh at 5m (not 2m) to stay well under quota.
  prices: { refreshEverySec: 5 * M, staleAfterSec: 15 * M } satisfies WarmPolicy,

  // On-chain collateral value in loan token (oracle read via viem) — feeds priceUsd + LTVs.
  // Mostly NAV oracles (slow-moving redemption rates); 5m refresh is ample and cuts RPC load.
  onchainCollateralValue: { refreshEverySec: 5 * M, staleAfterSec: 15 * M } satisfies WarmPolicy,
} as const;

// Exit slippage is NOT warmed from a live upstream — it is baked into collateralTokens.json by
// the app's weekly refresh script (scripts/refresh-exit-slippage.mjs). We read it from config and
// use the file mtime as its `asOf`. CONTRACT: 12h refresh, 24h grace.
export const EXIT_LIQUIDITY_STALE_AFTER_SEC = 24 * H;

// ── Cache keys ────────────────────────────────────────────────────────────────
export const KEYS = {
  morphoMarkets: (chainId: number) => `morpho:markets:${chainId}`,
  morphoBorrowHistory: (chainId: number) => `morpho:borrowHistory:${chainId}`,
  stablewatchApy: () => `apy:stablewatch-snapshot`,
  defillamaAll: (chainId: number) => `apy:defillama:all:${chainId}`,
  roycoAll: (chainId: number) => `apy:royco:all:${chainId}`,
  pendle: () => `apy:pendle:markets`,
  onchainStUSDS: () => `apy:onchain:stusds`,
  onchainSpUSDG: () => `apy:onchain:spusdg`,
  merkl: (chainId: number) => `merkl:incentives:${chainId}`,
  prices: (chainId: number) => `prices:coingecko:${chainId}`,
  onchainCollateralValue: (chainId: number) => `onchain:collateralValue:${chainId}`,
} as const;
