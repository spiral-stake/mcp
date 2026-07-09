// End-to-end composition parity (offline).
//
// Live golden-set parity needs recorded upstream captures + the app's composed output; that
// harness is driven by scripts/capture-parity.ts against real keys (see README). This test is
// the deterministic core of it: it seeds the RAW cache with a controlled fixture and asserts the
// composed /strategies output field-by-field, using the SAME verbatim leverage.ts the app runs.
// It locks the wiring — sourcing, LTV math, ladder, freshness, null-vs-absent, spiralHints
// isolation — so a regression in the port fails loudly.
import { describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";
import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readMarkets } from "../../src/data/markets.ts";
import { buildStrategies } from "../../src/core/strategy.ts";
import { calcLeverage, calcLeverageApy } from "../../src/core/leverage.ts";
import type { MorphoMarketData } from "../../src/sources/morpho.ts";

const CHAIN = 1;
const markets = readMarkets(CHAIN);
const m0 = markets[0]; // sUSDS / AUSD — stable (stablewatch), correlated, measured exit liquidity

const COLLATERAL_APY = "10.00";
const BORROW_APY = "5.00";

function seedStore() {
  const morpho: Record<string, MorphoMarketData> = {
    [m0.morphoMarketId]: {
      borrowApy: BORROW_APY,
      quarterlyBorrowApy: "5.10",
      supplyAssets: new BigNumber("1000000"),
      supplyAssetsUsd: 1_000_000,
      liquidityAssetsParsed: 0n,
      liquidityAssets: new BigNumber("400000"),
      liquidityAssetsUsd: 400_000,
      paLiquidityAssets: new BigNumber("500000"),
      paSharedLiquidity: [],
    },
  };
  rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 300);
  rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), { [m0.morphoMarketId]: new BigNumber("1.02") }, 900);
  rawStore.setOk(KEYS.prices(CHAIN), { [m0.loanToken.address]: new BigNumber("1") }, 300);
  rawStore.setOk(
    KEYS.stablewatchApy(),
    {
      stableApy: [
        {
          id: m0.collateralToken.info.stablewatchId,
          metrics: { apy: { avg7d: 10 } },
          history: [{ timestamp: "2026-07-01T00:00:00Z", apy: 10 }],
        },
      ],
    },
    43200,
  );
  rawStore.setOk(KEYS.merkl(CHAIN), { spot: {}, histories: {} }, 3600);
  rawStore.setOk(KEYS.morphoBorrowHistory(CHAIN), {}, 3600);
  rawStore.setOk(KEYS.defillamaAll(CHAIN), {}, 43200);
  rawStore.setOk(KEYS.roycoAll(CHAIN), {}, 43200);
  rawStore.setOk(KEYS.pendle(), [], 1800);
}

describe("strategy composition (seeded fixture)", () => {
  beforeEach(seedStore);

  it("produces a strategy for the seeded market with correct raw facts", () => {
    const env = buildStrategies(CHAIN);
    const s = env.strategies.find((x) => x.id === m0.morphoMarketId);
    expect(s).toBeDefined();
    if (!s) return;

    // yield facts
    expect(s.collateralApyPct).toBe(COLLATERAL_APY);
    expect(s.collateralApySource).toBe("stablewatch");

    // borrow facts (no incentive → net == gross; borrowIncentive block absent)
    expect(s.borrowApyPct).toBe(BORROW_APY);
    expect(s.quarterlyBorrowApyPct).toBe("5.10");
    expect(s.netBorrowApyPct).toBe(BORROW_APY);
    expect(s.borrowIncentive).toBeUndefined();

    // capacity facts
    expect(s.supplyUsd).toBe(1_000_000);
    expect(s.liquidityUsd).toBe(400_000);
    expect(s.publicAllocatorLiquidityUsd).toBe(500_000);
    expect(s.utilizationPct).toBe("60.00"); // (1,000,000 - 400,000) / 1,000,000

    // risk facts — LTVs from formatUnits(lltv, 16)
    expect(s.ltvPct.liquidation).toBe("94.50");
    expect(s.ltvPct.max).toBe("94.25");
  });

  it("builds the leverage ladder + defaultLeverage with the verbatim leverage.ts", () => {
    const env = buildStrategies(CHAIN);
    const s = env.strategies.find((x) => x.id === m0.morphoMarketId)!;

    // maxLeverage = calcLeverage(maxLtv)
    expect(s.maxLeverage).toBe(calcLeverage("94.25"));

    // first ladder point is 1x @ 0% LTV, APY == 1x collateral APY
    expect(s.leverageLadder[0]).toEqual({
      leverage: "1.0",
      ltvPct: "0.0",
      leverageApyPct: calcLeverageApy(true, COLLATERAL_APY, BORROW_APY, "0.00"),
    });
    // last ladder point is the exact max
    const last = s.leverageLadder[s.leverageLadder.length - 1];
    expect(last.leverage).toBe(s.maxLeverage);

    // default sits at safeLtv = maxLtv - 0.75 = 93.50
    expect(s.defaultLeverage.leverage).toBe(calcLeverage("93.50"));
    expect(s.defaultLeverage.ltvPct).toBe("93.5");
    expect(s.defaultLeverage.leverageApyPct).toBe(
      calcLeverageApy(true, COLLATERAL_APY, BORROW_APY, "93.50"),
    );
  });

  it("isolates the exit-liquidity verdict under spiralHints with thresholds (facts stay raw)", () => {
    const env = buildStrategies(CHAIN);
    const s = env.strategies.find((x) => x.id === m0.morphoMarketId)!;

    // raw facts
    expect(s.exitLiquidity.measured).toBe(true);
    expect(s.exitLiquidity.slippagePct?.["100000"]).toBe("0.51");
    expect(s.exitLiquidity.asOf).toBeTruthy();
    // the ONLY verdict lives in spiralHints and always carries its thresholds
    expect(s.spiralHints?.exitLiquidityTier?.value).toBe("deep");
    expect(s.spiralHints?.exitLiquidityTier?.thresholds).toEqual({
      listingMaxPct: 2,
      depthCleanMaxPct: 1.5,
    });
    // no verdict leaked into the raw exitLiquidity block
    expect(JSON.stringify(s.exitLiquidity)).not.toContain("deep");
  });

  it("attaches per-field-group freshness at the CONTRACT cadences", () => {
    const env = buildStrategies(CHAIN);
    const s = env.strategies.find((x) => x.id === m0.morphoMarketId)!;
    expect(s.freshness.borrow?.staleAfterSec).toBe(300); // Morpho ~2m warmer, 300s stale
    expect(s.freshness.collateralApy?.staleAfterSec).toBe(43200); // non-PT collateral APY 12h
    expect(s.freshness.exitLiquidity?.staleAfterSec).toBe(24 * 60 * 60); // 12h refresh, 24h grace
  });

  it("serves envelope metadata (asOf, chainId, count)", () => {
    const env = buildStrategies(CHAIN);
    expect(env.chainId).toBe(CHAIN);
    expect(env.count).toBe(env.strategies.length);
    expect(env.count).toBeGreaterThanOrEqual(1);
    expect(new Date(env.asOf).toString()).not.toBe("Invalid Date");
  });
});
