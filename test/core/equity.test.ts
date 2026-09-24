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
import { buildStrategies } from "../../src/core/strategy.ts";
import { partnerMarketCurator, NETNET_CREDIT_URL } from "../../src/data/robinhoodMarkets.ts";
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

// The agent contract must carry the two facts that tell same-ticker vaults apart: the curator of
// the stock market, and the collateral description (which names it too). Until 2026-09-24 neither
// left the app payload, so the Longbow and NetNet Credit NVDA vaults were indistinguishable.
describe("equity vaults on /v1/strategies — curator + description", () => {
  beforeEach(seed);

  it("names the curator on every vault and only on vaults", () => {
    const { strategies } = buildStrategies(CHAIN);
    const vaults = strategies.filter((s) => s.id.startsWith("equity-"));
    expect(vaults).toHaveLength(equityVaultsFor(CHAIN).length);
    for (const s of vaults) {
      const v = equityVaultsFor(CHAIN).find((c) => c.id === s.id)!;
      expect(s.curator).toBe(v.curator);
      expect(s.collateral.description).toContain(`${v.curator}'s Morpho market`);
    }
    // Non-vault strategies: Longbow's perp markets name Longbow; Spiral's own markets carry no key.
    const loops = composeSnapshot(CHAIN).markets.map((cm) => cm.market);
    for (const s of strategies.filter((s) => !s.id.startsWith("equity-"))) {
      const expected = partnerMarketCurator(CHAIN, loops.find((m) => m.morphoMarketId === s.id)!);
      if (expected) expect(s.curator).toBe(expected);
      else expect(s).not.toHaveProperty("curator");
    }
  });

  it("links a vault to its stock market's own page, never to a Morpho URL built from its synthetic id", () => {
    const { strategies } = buildStrategies(CHAIN);
    const byCurator = (c: string) => strategies.filter((s) => s.id.startsWith("equity-") && s.curator === c);
    for (const s of byCurator("Longbow")) expect(s.links?.market).toBe(`https://www.longbow.cash/borrow/${s.collateral.symbol}`);
    for (const s of byCurator("NetNet Credit")) expect(s.links?.market).toBe(NETNET_CREDIT_URL);
    for (const s of strategies) expect(s.links?.market).not.toContain("equity-");
  });

  it("omits the historical-APY block on a vault (no ladder history) instead of sending {}", () => {
    for (const s of buildStrategies(CHAIN).strategies.filter((s) => s.id.startsWith("equity-"))) {
      expect(s).not.toHaveProperty("historicalLeverageApyPct");
    }
  });

  it("tells the two NVDA vaults apart", () => {
    const nvda = buildStrategies(CHAIN).strategies.filter((s) => s.collateral.symbol === "NVDA");
    expect(nvda).toHaveLength(2);
    expect(new Set(nvda.map((s) => s.curator))).toEqual(new Set(["Longbow", "NetNet Credit"]));
  });
});

// A vault's exit is the stock -> USDG swap, so its exit liquidity is the stock's. The stock tokens
// are swept with the loop collaterals; the live reading is overlaid on the vault's info and reaches
// the agent contract (raw slippage + the tier hint + a truthful asOf). Unswept → unmeasured, no tier.
describe("equity vaults — exit liquidity from the live sweep", () => {
  beforeEach(seed);

  const spy = () => equityVaultsFor(CHAIN).find((v) => v.stock.symbol === "SPY")!;
  const SPY_EXIT = { exitSlippage100k: 0.1, exitSlippage500k: 0.3, exitSlippage1M: 0.45, exitSlippage5M: 9.8, exitSlippage10M: 40.1 };

  it("overlays the swept stock's slippage on its info; an unswept stock stays unmeasured", () => {
    rawStore.setOk(KEYS.exitLiquidity(CHAIN), { [spy().stock.address]: SPY_EXIT }, 86_400);
    const loops = composeSnapshot(CHAIN).markets.map((cm) => cm.market);
    const equity = buildEquityMarkets(CHAIN, loops);
    expect(equity.find((m) => m.collateralToken.symbol === "SPY")!.collateralToken.info.exitSlippage100k).toBe(0.1);
    expect(equity.find((m) => m.collateralToken.symbol === "TSLA")!.collateralToken.info.exitSlippage100k).toBeUndefined();
  });

  it("serves measured exit liquidity, the tier hint and the sweep's asOf on the vault strategy", () => {
    rawStore.setOk(KEYS.exitLiquidity(CHAIN), { [spy().stock.address]: SPY_EXIT }, 86_400);
    const view = rawStore.view(KEYS.exitLiquidity(CHAIN))!;
    const { strategies } = buildStrategies(CHAIN);

    const s = strategies.find((x) => x.id === spy().id)!;
    expect(s.exitLiquidity).toMatchObject({ measured: true, asOf: view.asOf, direction: "collateral_to_usdg" }); // Robinhood exits into USDG
    expect(s.exitLiquidity.slippagePct).toEqual({ "100000": "0.10", "500000": "0.30", "1000000": "0.45", "5000000": "9.80", "10000000": "40.10" });
    expect(s.spiralHints?.exitLiquidityTier?.value).toBe("good"); // $1M clean, $5M not
    expect(s.freshness.exitLiquidity?.asOf).toBe(view.asOf);

    const tsla = strategies.find((x) => x.collateral.symbol === "TSLA")!;
    expect(tsla.exitLiquidity).toEqual({ measured: false });
    expect(tsla.spiralHints?.exitLiquidityTier).toBeUndefined();
    expect(tsla.freshness.exitLiquidity).toBeUndefined();
  });
});
