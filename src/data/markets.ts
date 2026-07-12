// Port of v2-client/src/data/index.ts (readMarkets) for the server.
//
// Builds the static Market list by merging the per-chain addresses file with the curated
// collateralTokens / loanTokens / oracleTypes registries — identical logic to the app, so
// the LTV-independent fields it produces (info, oracleType, PT maturity/symbol split) match
// like-for-like. The dynamic fields (apy, prices, on-chain value, Morpho/Merkl data) are
// layered on later by the composition, exactly as the app does in FlashLeverage.createInstance.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  Market,
  CollateralTokenInfo,
  LoanTokenInfo,
  OracleType,
  Token,
} from "../types/index.ts";
import { getMaturityDate, getMaturityDaysLeft } from "../core/pt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(resolve(here, rel), "utf8")) as T;

interface MarketObject {
  [symbol: string]: Market;
}
interface AddressesFile {
  markets: MarketObject;
  [key: string]: unknown;
}

const collateralTokens = readJson<Record<string, CollateralTokenInfo>>("./collateralTokens.json");
// loanTokens.json is an ARRAY of { address, coingeckoId, ... } (mirrors the app). It must be read
// as an array and indexed by address — treating it as an object keys everything by array index,
// which silently breaks price lookups (loanToken USD falls back to $1 for non-stable loan tokens).
const loanTokens = readJson<Array<{ address: string; coingeckoId?: string } & LoanTokenInfo>>(
  "./loanTokens.json",
);
const loanTokenByAddress = new Map(loanTokens.map((t) => [t.address.toLowerCase(), t]));
const oracleTypes = readJson<Record<string, OracleType>>("./oracleTypes.json");

const addressesCache = new Map<number, AddressesFile>();
export function readAddresses(chainId: number): AddressesFile {
  const cached = addressesCache.get(chainId);
  if (cached) return cached;
  const file = readJson<AddressesFile>(`./addresses/${chainId}.json`);
  addressesCache.set(chainId, file);
  return file;
}

export function readMarkets(chainId: number): Market[] {
  const { markets } = readAddresses(chainId);

  // Curated oracle-address -> pricing methodology, matched case-insensitively so a checksum
  // difference between oracleTypes.json and the addresses file can never silently drop a badge.
  const oracleTypeByAddress = new Map(
    Object.entries(oracleTypes).map(([address, type]) => [address.toLowerCase(), type]),
  );

  return Object.keys(markets)
    // Non-correlated (leveraged-long) markets are excluded at the root: the app no longer offers
    // that profile, and their `leverageApyPct` is a sign-flipped carry cost that misleads agents.
    // Dropping them here means the warmer never fetches Morpho/oracle/price data for them at all.
    .filter((marketId) => markets[marketId].correlated)
    .map((marketId) => {
    // Deep-ish clone so the shared registries are never mutated across calls (the app relies
    // on a fresh module import per load; the server keeps them resident, so we copy).
    const market = structuredClone(markets[marketId]);

    market.collateralToken.info = collateralTokens[market.collateralToken.address];
    market.loanToken.coingeckoId = loanTokenByAddress.get(market.loanToken.address.toLowerCase())?.coingeckoId;
    market.oracleType = market.oracle
      ? oracleTypeByAddress.get(market.oracle.toLowerCase())
      : undefined;

    if (!collateralTokens[market.collateralToken.address]) {
      // Mirrors the app's console warning — an unconfigured collateral is a data gap to surface.
      console.warn(
        "[markets] missing collateralTokens entry:",
        market.collateralToken.symbol,
        market.collateralToken.address,
      );
    }

    if (market.collateralToken.symbol.startsWith("PT-")) {
      market.collateralToken.isPt = true;
      const maturityDate = getMaturityDate(market.collateralToken.symbol);
      market.collateralToken.maturityDate = maturityDate;
      market.collateralToken.maturityDaysLeft = getMaturityDaysLeft(maturityDate);
      market.collateralToken.symbolExtended = market.collateralToken.symbol;
      market.collateralToken.symbol = `${market.collateralToken.symbol.split("-")[0]}-${
        market.collateralToken.symbol.split("-")[1]
      }`;

      if (market.collateralToken.underlying) {
        market.collateralToken.underlying.coingeckoId =
          collateralTokens[market.collateralToken.underlying.address]?.coingeckoId;
      }
    } else {
      market.collateralToken.isPt = false;
    }

    return market;
  });
}

export function readToken(chainId: number, symbol: string): Token | undefined {
  const file = readAddresses(chainId) as unknown as Record<string, Token>;
  return file[symbol];
}

export const registries = { collateralTokens, loanTokens, oracleTypes };

// Exit slippage is baked into collateralTokens.json by the app's weekly refresh script; its file
// mtime is the best available `asOf` for the exit-liquidity field group (the config carries no
// per-field timestamp). Computed once at startup.
export const collateralTokensAsOf: string = (() => {
  try {
    return statSync(resolve(here, "./collateralTokens.json")).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
})();
