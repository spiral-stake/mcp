// Equity vaults: the synthetic stock Market is CLONED from its yield-loop market, so every field
// that describes the collateral must be overridden. This pins the token info — before this test
// every stock's "i" hover (and the agent surface's yieldSource / links / exit liquidity) described
// syrupUSDG, the yield leg, instead of the stock.
import { describe, it, expect, beforeEach, vi } from "vitest";
import BigNumber from "bignumber.js";

vi.hoisted(() => {
  process.env.EQUITY_VAULTS_ENABLED = "true";
});

import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { composeSnapshot } from "../../src/core/compose.ts";
import { readMarkets } from "../../src/data/markets.ts";
import { buildEquityMarkets } from "../../src/core/equity.ts";
import { equityVaultsFor } from "../../src/data/equityVaults.ts";
import { TokenCategory } from "../../src/types/index.ts";

const CHAIN = 4663;

function seed() {
  const markets = readMarkets(CHAIN);
  const morpho = Object.fromEntries(
    markets.map((m) => [
      m.morphoMarketId,
      {
        borrowApy: "4.00",
        quarterlyBorrowApy: "4.00",
        supplyAssets: new BigNumber(1_000_000),
        supplyAssetsUsd: 1_000_000,
        liquidityAssetsParsed: 50_000_000_000n,
        liquidityAssets: new BigNumber(50_000),
        liquidityAssetsUsd: 50_000,
        paLiquidityAssets: new BigNumber(50_000),
        paSharedLiquidity: [],
        curators: [],
      },
    ]),
  );
  const values = Object.fromEntries(markets.map((m) => [m.morphoMarketId, new BigNumber(1)]));
  rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 900);
  rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), values, 900);

  const equityRaw = Object.fromEntries(
    equityVaultsFor(CHAIN).map((v) => [
      v.stockMarketId,
      { borrowApyPct: "6.00", liquidityUsd: 100_000, liquidityAssetsParsed: "100000000000", supplyUsd: 500_000, stockPriceUsd: 200 },
    ]),
  );
  rawStore.setOk(KEYS.equityMarkets(CHAIN), equityRaw, 900);
}

describe("buildEquityMarkets — collateral token info", () => {
  beforeEach(seed);

  const build = () => {
    const loops = composeSnapshot(CHAIN).markets.map((cm) => cm.market);
    return { loops, equity: buildEquityMarkets(CHAIN, loops) };
  };

  it("builds one market per configured vault", () => {
    const { equity } = build();
    expect(equity.map((m) => m.collateralToken.symbol)).toEqual(equityVaultsFor(CHAIN).map((v) => v.stock.symbol));
  });

  it("describes the STOCK, not the yield leg it was cloned from", () => {
    const { loops, equity } = build();
    for (const m of equity) {
      const v = equityVaultsFor(CHAIN).find((c) => c.id === m.morphoMarketId)!;
      const yieldMarket = loops.find((l) => l.morphoMarketId.toLowerCase() === v.yieldMarketId.toLowerCase())!;
      const yieldInfo = yieldMarket.collateralToken.info;
      const info = m.collateralToken.info;

      expect(info.category).toBe(TokenCategory.Stocks);
      // Chainlink RH<stock>/USD: the share's traded price, curated as "market" in oracleTypes.json.
      expect(m.oracleType).toBe("market");
      expect(info.project).toBe(v.stock.name);
      expect(info.underlyingCollateral).toBe(v.stock.underlying);
      expect(info.tradingViewSymbol).toBe(v.stock.tradingViewSymbol);

      // The hover's copy names this stock and the curator, and never reads as the yield token's.
      expect(info.description).toContain(`${v.stock.symbol} is Robinhood's tokenized`);
      expect(info.description).toContain(`${v.curator}'s Morpho market`);
      expect(info.description).toContain(`${v.targetLtvPct}% of its value`);
      expect(info.description).not.toBe(yieldInfo.description);
      expect(info.description!.startsWith(yieldMarket.collateralToken.symbol)).toBe(false);
      expect(info.website).not.toBe(yieldInfo.website);
      expect(info.twitter).not.toBe(yieldInfo.twitter);

      // Yield source is the loop the borrowed USDG goes into — named, not the yield token's own label.
      expect(info.yieldSource).toBe(`${yieldMarket.collateralToken.symbol} loop (${yieldInfo.project})`);
    }
  });

  it("inherits none of the yield token's data-source ids or exit-slippage snapshot", () => {
    const { equity } = build();
    for (const m of equity) {
      const info = m.collateralToken.info;
      expect(info.defillamaId).toBeUndefined();
      expect(info.coingeckoId).toBeUndefined();
      expect(info.stablewatchId).toBeUndefined();
      expect(info.royco).toBeUndefined();
      expect(info.exitSlippage100k).toBeUndefined();
      expect(info.exitSlippage1M).toBeUndefined();
      expect(info.noSwapRoute).toBeUndefined();
      expect(info.manualExitOnly).toBeUndefined();
    }
  });

  it("the two NVDA vaults share a project so the app groups them", () => {
    const { equity } = build();
    const nvda = equity.filter((m) => m.collateralToken.symbol === "NVDA");
    expect(nvda).toHaveLength(2);
    expect(new Set(nvda.map((m) => m.collateralToken.info.project)).size).toBe(1);
    expect(nvda[0].collateralToken.info.description).toContain("Longbow");
    expect(nvda[1].collateralToken.info.description).toContain("NetNet Credit");
  });
});
