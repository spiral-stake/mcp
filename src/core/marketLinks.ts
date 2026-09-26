// Where a market is browsed outside the app — mirrors v2-client/src/config/robinhoodMarkets.ts and
// components/low-level/MarketLink.tsx. On Robinhood Chain the perp markets and the equity vaults'
// stock legs are Longbow's (browsed on longbow.cash) or NetNet Credit's (one credit page); every
// other market keeps its Morpho link. Display-only — the portfolio read emits these so an ops view
// links exactly where the user's card does.
//
// NOTE: the slug/market tables below are DUPLICATED from the app's robinhoodMarkets.ts. A market
// added there must be added here too, or the ops card links to Morpho for it.
import type { Market } from "../types/index.ts";

export const ROBINHOOD_CHAIN_ID = 4663;

// Longbow market slugs — keyed by morphoMarketId (perps) or equityVault.stockMarketId (vaults).
const LONGBOW_MARKET_SLUGS: Record<string, string> = {
  "0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589": "WSNET-NN",
  "0xaba3ac501ce4c6b80c08ed0dba19e1ac0de495f17af3ed692a38e92d176a6c9e": "PONS",
  "0x039503b6308d6d818d181e626d3fbc667d6e68393c3d74332a6124cd2dd6e755": "CASHCAT_LEGACY",
  "0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55": "SPY",
  "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc": "NVDA",
  "0xb41b34c5989420ad080e79363a9cfe3e23bec7459fcd2d88029250da370288df": "TSLA",
};

export const NETNET_CREDIT_URL = "https://app.netnet.capital/#/credit";
const NETNET_STOCK_MARKETS = new Set([
  "0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e", // NVDA
  "0x9b4b47cdf7e295341c6c6cdfd3efb9805c4a5b3d580dba0c0c39d3a4232b297b", // SPCX
  "0xdeb4782d012d5fd3b24962538c2f6559049d70bda4dabd2e4212dacb96c28d45", // AAPL
]);

const MORPHO_CHAIN_SLUG: Record<number, string> = {
  1: "ethereum",
  4663: "robinhood-chain",
};

export type ExternalLinkKind = "morpho" | "longbow" | "netnet";

export function isNetNetMarket(market: Market, chainId: number): boolean {
  return (
    chainId === ROBINHOOD_CHAIN_ID &&
    NETNET_STOCK_MARKETS.has((market.equityVault?.stockMarketId ?? market.morphoMarketId).toLowerCase())
  );
}

export function longbowSlug(market: Market, chainId: number): string | undefined {
  if (chainId !== ROBINHOOD_CHAIN_ID) return undefined;
  const marketId = market.equityVault?.stockMarketId ?? market.morphoMarketId;
  const pinned = LONGBOW_MARKET_SLUGS[marketId.toLowerCase()];
  if (pinned) return pinned;
  return market.equityVault ? market.collateralToken.symbol.toUpperCase() : undefined;
}

/** The external "browse this market" link the app's MarketLink renders for `market`. */
export function externalMarketLink(market: Market, chainId: number): { url: string; kind: ExternalLinkKind } {
  if (isNetNetMarket(market, chainId)) return { url: NETNET_CREDIT_URL, kind: "netnet" };
  const slug = longbowSlug(market, chainId);
  if (slug) return { url: `https://www.longbow.cash/borrow/${slug}`, kind: "longbow" };
  const chainSlug = MORPHO_CHAIN_SLUG[chainId] ?? "ethereum";
  const tokenSlug = `${market.loanToken.symbol.toLowerCase()}-${market.collateralToken.symbol.toLowerCase()}`;
  return { url: `https://app.morpho.org/${chainSlug}/variable/${market.morphoMarketId}/${tokenSlug}#market`, kind: "morpho" };
}

/** The in-app strategy page the position card's title links to. */
export function appStrategyLink(appUrl: string, market: Market, chainId: number): string {
  const profile = market.correlated ? "yield" : "perp";
  return `${appUrl}/${chainId}/strategies/${market.morphoMarketId}/${market.collateralToken.symbol}-${market.loanToken.symbol}?profile=${profile}`;
}
