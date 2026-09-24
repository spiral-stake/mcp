// Where a market lives, and who curates it — the agent-surface port of the app's
// v2-client/src/config/robinhoodMarkets.ts (kept in sync by hand; the app's copy also carries icons).
//
// Spiral's own markets are browsed on the Morpho app. On Robinhood Chain the perp markets and the
// equity-vault stock legs are partner markets: Longbow's are browsed on longbow.cash (slug pinned per
// market id — it can't be derived from the symbol: wsNET's is "WSNET-NN", and Longbow lists a
// separate "WSNET" market this app doesn't use; source: https://www.longbow.cash/api/markets), and
// NetNet Credit's on its single credit page. Spiral's Robinhood stable loops and the second PONS
// market aren't in Longbow's registry and keep their Morpho link.
import { ROBINHOOD_CHAIN_ID } from "../config/chains.ts";
import type { Market } from "../types/index.ts";

const MORPHO_CHAIN_SLUG: Record<number, string> = {
  1: "ethereum",
  [ROBINHOOD_CHAIN_ID]: "robinhood-chain",
};

export const LONGBOW_MARKET_SLUGS: Record<string, string> = {
  // Perp markets, keyed by morphoMarketId.
  "0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589": "WSNET-NN",
  "0xaba3ac501ce4c6b80c08ed0dba19e1ac0de495f17af3ed692a38e92d176a6c9e": "PONS",
  "0x039503b6308d6d818d181e626d3fbc667d6e68393c3d74332a6124cd2dd6e755": "CASHCAT_LEGACY",
  // Equity vaults, keyed by equityVault.stockMarketId (the vault's own id is synthetic).
  "0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55": "SPY",
  "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc": "NVDA",
  "0xb41b34c5989420ad080e79363a9cfe3e23bec7459fcd2d88029250da370288df": "TSLA",
};

// NetNet Credit's stock markets (keyed by equityVault.stockMarketId). Checked BEFORE the Longbow
// ticker fallback, since NetNet's NVDA market shares its ticker with Longbow's.
export const NETNET_CREDIT_URL = "https://app.netnet.capital/#/credit";
export const NETNET_STOCK_MARKETS = new Set([
  "0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e", // NVDA
  "0x9b4b47cdf7e295341c6c6cdfd3efb9805c4a5b3d580dba0c0c39d3a4232b297b", // SPCX
  "0xdeb4782d012d5fd3b24962538c2f6559049d70bda4dabd2e4212dacb96c28d45", // AAPL
]);

// The market whose page/curator we mean: a vault's stock leg, else the market itself.
const partnerMarketId = (market: Market) => (market.equityVault?.stockMarketId ?? market.morphoMarketId).toLowerCase();

const isNetNetMarket = (market: Market, chainId: number) =>
  chainId === ROBINHOOD_CHAIN_ID && NETNET_STOCK_MARKETS.has(partnerMarketId(market));

// The Longbow market slug for this market, or undefined when it belongs on the Morpho app.
const longbowSlug = (market: Market, chainId: number): string | undefined => {
  if (chainId !== ROBINHOOD_CHAIN_ID) return undefined;
  const pinned = LONGBOW_MARKET_SLUGS[partnerMarketId(market)];
  if (pinned) return pinned;
  // An equity vault not on NetNet is a Longbow stock market, and Longbow keys those by ticker — so a
  // vault added later still resolves instead of falling back to a Morpho URL built from its
  // synthetic "equity-0x…" id, which has no page there.
  return market.equityVault ? market.collateralToken.symbol.toUpperCase() : undefined;
};

// Who curates the market (the platform, not a vault supplying it). Undefined = Spiral's own market.
export function partnerMarketCurator(chainId: number, market: Market): string | undefined {
  if (isNetNetMarket(market, chainId)) return "NetNet Credit";
  if (longbowSlug(market, chainId)) return "Longbow";
  return undefined;
}

// The page where a human can inspect the market the strategy runs on.
export function marketUrl(chainId: number, market: Market): string {
  if (isNetNetMarket(market, chainId)) return NETNET_CREDIT_URL;
  const slug = longbowSlug(market, chainId);
  if (slug) return `https://www.longbow.cash/borrow/${slug}`;
  const chainSlug = MORPHO_CHAIN_SLUG[chainId] ?? "ethereum";
  const tokenSlug = `${market.loanToken.symbol.toLowerCase()}-${market.collateralToken.symbol.toLowerCase()}`;
  return `https://app.morpho.org/${chainSlug}/variable/${market.morphoMarketId}/${tokenSlug}#market`;
}
