// wsNET staking distribution: display-only, attached to wsNET alone, and never folded into `apy`
// (it is NET-denominated and already priced in; calcLeverageApy's uncorrelated branch would flip it).
import { describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";
import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { composeSnapshot } from "../../src/core/compose.ts";
import { readMarkets } from "../../src/data/markets.ts";

const CHAIN = 4663;
const WSNET = "0x63C12667638f2Ae6fC6ae09B43D98Ec84a8586eA";
const STAKING = { index: "3.2581", monthlyRatePct: "54.71", windowDays: 7 };

function seedMarkets() {
  const markets = readMarkets(CHAIN);
  const morpho = Object.fromEntries(
    markets.map((m) => [
      m.morphoMarketId,
      {
        borrowApy: "40.00",
        quarterlyBorrowApy: "40.00",
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
  const values = Object.fromEntries(markets.map((m) => [m.morphoMarketId, new BigNumber(2)]));
  rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 900);
  rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), values, 900);
}

const wsNET = () =>
  composeSnapshot(CHAIN).markets.find((m) => m.market.collateralToken.address === WSNET)!.market;

describe("wsNET staking distribution", () => {
  beforeEach(() => seedMarkets());

  it("is absent until the on-chain read has landed", () => {
    rawStore.setError(KEYS.onchainWsNETStaking(), "rpc down");
    expect(wsNET().collateralToken.stakingDistribution).toBeUndefined();
  });

  it("attaches to wsNET only, and leaves apy untouched", () => {
    rawStore.setOk(KEYS.onchainWsNETStaking(), STAKING, 900);
    const snapshot = composeSnapshot(CHAIN).markets;
    const w = snapshot.find((m) => m.market.collateralToken.address === WSNET)!.market;
    expect(w.collateralToken.stakingDistribution).toEqual(STAKING);
    expect(w.collateralToken.apy).toBe("0.00");
    for (const m of snapshot.filter((m) => m.market.collateralToken.address !== WSNET)) {
      expect(m.market.collateralToken.stakingDistribution).toBeUndefined();
    }
  });

  it("does not move the perp financing number", () => {
    rawStore.setError(KEYS.onchainWsNETStaking(), "rpc down");
    const before = wsNET().defaultLeverageApy;
    rawStore.setOk(KEYS.onchainWsNETStaking(), STAKING, 900);
    expect(wsNET().defaultLeverageApy).toBe(before);
  });
});
