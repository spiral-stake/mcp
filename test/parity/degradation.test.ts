// Graceful degradation — the production-critical guarantee from the brief:
// "a stale/failed upstream serves last-good + visible stale age per field-group — never dropped,
// never coerced to 0."
import { describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";
import { RawStore, rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readMarkets } from "../../src/data/markets.ts";
import { buildStrategies } from "../../src/core/strategy.ts";
import type { MorphoMarketData } from "../../src/sources/morpho.ts";

const CHAIN = 1;
const m0 = readMarkets(CHAIN)[0];

describe("RawStore last-good semantics", () => {
  it("keeps the last-good value when a refresh fails, and flags it degraded", () => {
    const store = new RawStore();
    store.setOk("k", { v: 1 }, 300);
    store.setError("k", "upstream 500");

    const view = store.view<{ v: number }>("k");
    expect(view?.value).toEqual({ v: 1 }); // value survives — never dropped, never zeroed
    expect(view?.degraded).toBe(true); // last attempt failed
    expect(store.isPrimed("k")).toBe(true);
  });

  it("does not fabricate a value when a key has never been primed", () => {
    const store = new RawStore();
    store.setError("k", "upstream 500", 300);
    expect(store.view("k")).toBeUndefined(); // unknown ≠ zero
    expect(store.isPrimed("k")).toBe(false);
  });

  it("surfaces the stale age once past staleAfterSec", () => {
    const store = new RawStore();
    const tenMinAgo = Date.now() - 600_000;
    store.setOk("k", { v: 1 }, 300, tenMinAgo); // 600s old, 300s budget

    const view = store.view<{ v: number }>("k");
    expect(view?.stale).toBe(true);
    expect(view?.staleForSec).toBeGreaterThanOrEqual(299); // ~300s past budget
    expect(view?.value).toEqual({ v: 1 }); // still served
  });
});

describe("strategy freshness under a stale upstream", () => {
  const morpho: Record<string, MorphoMarketData> = {
    [m0.morphoMarketId]: {
      borrowApy: "5.00",
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

  beforeEach(() => {
    rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), { [m0.morphoMarketId]: new BigNumber("1.02") }, 900);
    rawStore.setOk(KEYS.prices(CHAIN), { [m0.loanToken.address]: new BigNumber("1") }, 300);
    rawStore.setOk(KEYS.merkl(CHAIN), { spot: {}, histories: {} }, 3600);
    rawStore.setOk(
      KEYS.stablewatchApy(),
      { stableApy: [{ id: m0.collateralToken.info.stablewatchId, metrics: { apy: { avg7d: 10 } }, history: [] }] },
      43200,
    );
  });

  it("serves last-good borrow numbers with a visible staleForSec instead of dropping them", () => {
    // Morpho warmed 10 minutes ago; its budget is 300s → stale by ~300s.
    rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 300, Date.now() - 600_000);

    const s = buildStrategies(CHAIN).strategies.find((x) => x.id === m0.morphoMarketId)!;

    // numbers are still the real last-good values, NOT zeros
    expect(s.borrowApyPct).toBe("5.00");
    expect(s.supplyUsd).toBe(1_000_000);
    // and the staleness is visible to the consumer
    expect(s.freshness.borrow?.staleAfterSec).toBe(300);
    expect(s.freshness.borrow?.staleForSec).toBeGreaterThanOrEqual(299);
  });

  it("omits staleForSec while the group is within its freshness budget", () => {
    rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 300);
    const s = buildStrategies(CHAIN).strategies.find((x) => x.id === m0.morphoMarketId)!;
    expect(s.freshness.borrow?.staleForSec).toBeUndefined();
  });
});
