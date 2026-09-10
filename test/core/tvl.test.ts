// /v1/tvl — offline: the chain reads are faked behind TvlReads, the valuation inputs (collateral
// values, prices) are seeded into the raw store exactly as the warmer would write them.
//
// Locks: aggregation on a fixture · a liquidated (zero-collateral) position contributes nothing ·
// an unconfigured market resolves through morpho.idToMarketParams + the oracle price() path · a
// broken loan-price feed is clamped to $1 · the route 503s until primed and serves partial chains.
import { describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";
import { app } from "../../src/http/app.ts";
import { rawStore, RawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readAddresses, readMarkets } from "../../src/data/markets.ts";
import { fetchChainTvl, __resetTvlScanCache, deriveProxyAddress, type TvlReads, type RawLeveragePosition } from "../../src/sources/tvl.ts";
import { aggregateTvl, clampLoanPrice, collateralValueViaOracle, sumChainTvl } from "../../src/core/tvl.ts";
import type { MarketParams } from "../../src/types/index.ts";

const CHAIN = 1;
const m0 = readMarkets(CHAIN)[0]; // sUSDS (18) / AUSD (6)
const FLASH_LEVERAGE = readAddresses(CHAIN).flashLeverageAddress as string;
// FlashLeverage's CREATE nonces: 1 = the UserProxy implementation, 2.. = user proxies.
const proxyAt = (nonce: number) => deriveProxyAddress(FLASH_LEVERAGE, nonce).toLowerCase();

const USER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USER_C = "0xcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcb";
const P1 = "0x1111111111111111111111111111111111111111";
const P2 = "0x2222222222222222222222222222222222222222";
const P3 = "0x3333333333333333333333333333333333333333";
const P4 = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";

// A market that is NOT in the configured list (delisted / external): resolved via idToMarketParams.
const DELISTED_ID = "0x" + "ff".repeat(32);
const DELISTED_LOAN = "0xcccccccccccccccccccccccccccccccccccccccc";
const DELISTED_PARAMS: MarketParams = {
  loanToken: DELISTED_LOAN,
  collateralToken: "0xdddddddddddddddddddddddddddddddddddddddd",
  oracle: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  irm: "0x1111111111111111111111111111111111111111",
  lltv: 860000000000000000n,
};

const pos = (open: boolean, marketId: string, userProxy: string): RawLeveragePosition => ({
  open,
  marketId,
  userProxy,
  amountDepositedInLoanToken: 0n,
  amountReturnedInLoanToken: 0n,
});

interface Calls {
  proxyUsers: string[][];
  idToMarketParams: string[][];
  oraclePrices: string[][];
  tokenDecimals: string[][];
}

function fakeReads(opts: { proxyCount?: number } = {}): { reads: TvlReads; calls: Calls } {
  const calls: Calls = { proxyUsers: [], idToMarketParams: [], oraclePrices: [], tokenDecimals: [] };
  // Chain state: nonce 1 = implementation (s_user = FlashLeverage), nonce 2 = USER_A's proxy,
  // nonce 3 = USER_B's, nonce 4 = USER_C's (only exists once proxyCount > 4).
  const proxyUser: Record<string, string> = {
    [proxyAt(1)]: FLASH_LEVERAGE,
    [proxyAt(2)]: USER_A.toUpperCase().replace("0X", "0x"), // checksum-ish casing must not split a user
    [proxyAt(3)]: USER_B,
    [proxyAt(4)]: USER_C,
  };
  let proxyCount = opts.proxyCount ?? 4;
  const positions: Record<string, RawLeveragePosition[]> = {
    [USER_A]: [
      pos(true, m0.morphoMarketId, P1), // live: 1000 sUSDS collateral, debt 800 AUSD
      pos(true, m0.morphoMarketId, P2), // liquidated: zero collateral, dangling borrow shares
      pos(false, m0.morphoMarketId, P3), // closed
    ],
    [USER_B]: [
      pos(true, DELISTED_ID, P4), // delisted market: 5 units collateral, oracle 2:1, debt 4
      pos(true, m0.morphoMarketId, ZERO), // no proxy → ignored
    ],
  };
  const morpho: Record<string, { borrowShares: bigint; collateral: bigint }> = {
    [P1]: { borrowShares: 1n, collateral: 1000n * 10n ** 18n },
    [P2]: { borrowShares: 5n, collateral: 0n },
    [P4]: { borrowShares: 7n, collateral: 5n * 10n ** 18n },
  };
  const debtByShares: Record<string, bigint> = { "1": 800n * 10n ** 6n, "5": 999_999n * 10n ** 6n, "7": 4n * 10n ** 18n };

  const reads: TvlReads & { setProxyCount(n: number): void } = {
    setProxyCount: (n) => (proxyCount = n),
    proxyCount: async () => proxyCount,
    proxyUsers: async (proxies) => {
      calls.proxyUsers.push(proxies.map((p) => p.toLowerCase()));
      return proxies.map((p) => proxyUser[p.toLowerCase()]); // undefined = not a proxy (read reverted)
    },
    userPositions: async (users) => users.map((u) => positions[u.toLowerCase()] ?? []),
    idToMarketParams: async (ids) => {
      calls.idToMarketParams.push(ids);
      return ids.map((id) => (id === DELISTED_ID ? DELISTED_PARAMS : { ...DELISTED_PARAMS, loanToken: ZERO }));
    },
    morphoPositions: async (cs) => cs.map((c) => morpho[c.userProxy] ?? { borrowShares: 0n, collateral: 0n }),
    sharesValueInLoanToken: async (cs) => cs.map((c) => debtByShares[c.borrowShares.toString()] ?? 0n),
    oraclePrices: async (oracles) => {
      calls.oraclePrices.push(oracles);
      return oracles.map((o) => (o === DELISTED_PARAMS.oracle ? 2n * 10n ** 36n : undefined));
    },
    tokenDecimals: async (tokens) => {
      calls.tokenDecimals.push(tokens);
      return tokens.map(() => 18);
    },
  };
  return { reads, calls };
}

function seedValuation(store: RawStore, loanPrice: BigNumber | undefined = new BigNumber(1)) {
  store.setOk(KEYS.onchainCollateralValue(CHAIN), { [m0.morphoMarketId]: new BigNumber("1.05") }, 900);
  store.setOk(KEYS.prices(CHAIN), loanPrice ? { [m0.loanToken.address]: loanPrice } : {}, 300);
}

beforeEach(() => __resetTvlScanCache());

describe("fetchChainTvl (fixture)", () => {
  it("aggregates net equity / gross collateral / debt, skips liquidated + closed + proxy-less positions", async () => {
    const store = new RawStore();
    seedValuation(store);
    const { reads, calls } = fakeReads();

    const out = await fetchChainTvl(CHAIN, reads, store);

    // P1: 1000 sUSDS × 1.05 = 1050 AUSD collateral, 800 AUSD debt.
    // P4 (delisted): 5 × 2 = 10 loan units collateral, 4 debt, priced at the $1 default.
    // P2 (liquidated, collateral 0) contributes NOTHING even though its shares would value 999,999.
    expect(out).toEqual({ chainId: CHAIN, grossTvlUsd: 1060, borrowedUsd: 804, tvlUsd: 256, positions: 2, users: 2 });
    expect(out.tvlUsd + out.borrowedUsd).toBeCloseTo(out.grossTvlUsd, 2);

    // Fallback path was exercised for the delisted market only.
    expect(calls.idToMarketParams).toEqual([[DELISTED_ID]]);
    expect(calls.oraclePrices).toEqual([[DELISTED_PARAMS.oracle]]);
    expect(calls.tokenDecimals).toEqual([[DELISTED_LOAN]]);
  });

  it("a liquidated position contributes zero to every figure", async () => {
    const store = new RawStore();
    seedValuation(store);
    const { reads } = fakeReads();
    // Only USER_A's liquidated position is open with a proxy.
    reads.userPositions = async (users) => users.map((u) => (u === USER_A ? [pos(true, m0.morphoMarketId, P2)] : []));

    const out = await fetchChainTvl(CHAIN, reads, store);
    expect(out).toEqual({ chainId: CHAIN, grossTvlUsd: 0, borrowedUsd: 0, tvlUsd: 0, positions: 0, users: 0 });
  });

  it("clamps a broken loan-price feed to $1 instead of printing millions of debt", async () => {
    const store = new RawStore();
    seedValuation(store, new BigNumber("84000000")); // the bad feed that once printed $84M on dust
    const { reads } = fakeReads();

    const out = await fetchChainTvl(CHAIN, reads, store);
    expect(out.grossTvlUsd).toBe(1060);
    expect(out.borrowedUsd).toBe(804);
    expect(out.tvlUsd).toBe(256);
  });

  it("discovers users from FlashLeverage's nonce-derived proxies and only resolves NEW nonces on refresh", async () => {
    const store = new RawStore();
    seedValuation(store);
    const { reads, calls } = fakeReads({ proxyCount: 4 });

    const first = await fetchChainTvl(CHAIN, reads, store);
    expect(first.users).toBe(2);
    // Nonce 1 (the implementation) is never read; nonces 2..3 are resolved once.
    expect(calls.proxyUsers).toEqual([[proxyAt(2), proxyAt(3)]]);

    // No new proxies → no proxy reads at all; numbers unchanged.
    expect(await fetchChainTvl(CHAIN, reads, store)).toEqual(first);
    expect(calls.proxyUsers).toHaveLength(1);

    // A new user opens (FlashLeverage nonce advances) → only the new nonce is resolved.
    (reads as any).setProxyCount(5);
    reads.userPositions = async (users) => users.map((u) => (u.toLowerCase() === USER_C ? [pos(true, m0.morphoMarketId, P1)] : []));
    const third = await fetchChainTvl(CHAIN, reads, store);
    expect(calls.proxyUsers).toEqual([[proxyAt(2), proxyAt(3)], [proxyAt(4)]]);
    expect(third.users).toBe(1);
    expect(third.positions).toBe(1);
  });
});

describe("core/tvl helpers", () => {
  it("clampLoanPrice: inside the band passes, outside → 1, unpriced → 1, exempt tokens keep their price", () => {
    expect(clampLoanPrice(new BigNumber("0.998")).toNumber()).toBe(0.998);
    expect(clampLoanPrice(new BigNumber("0.04")).toNumber()).toBe(1);
    expect(clampLoanPrice(new BigNumber("2.5")).toNumber()).toBe(1);
    expect(clampLoanPrice(new BigNumber("84000000")).toNumber()).toBe(1);
    expect(clampLoanPrice(undefined).toNumber()).toBe(1);
    expect(clampLoanPrice(new BigNumber("0")).toNumber()).toBe(1);
    expect(clampLoanPrice(new BigNumber("3500"), true).toNumber()).toBe(3500); // WETH-class loan token
  });

  it("collateralValueViaOracle applies Morpho's 1e36 scale + decimals adjustment", () => {
    // 18-dec collateral → 6-dec loan: price carries 10^(6-18) → 1e36 × 1e-12 × 1.5 for 1.5 loan/collateral.
    const price = (15n * 10n ** 35n) / 10n ** 12n;
    expect(collateralValueViaOracle(2n * 10n ** 18n, price, 6).toFixed(6)).toBe("3.000000");
    // Equal decimals: price 2e36 → 2 loan per collateral.
    expect(collateralValueViaOracle(5n * 10n ** 18n, 2n * 10n ** 36n, 18).toFixed(2)).toBe("10.00");
  });

  it("sumChainTvl keeps tvl + borrowed = gross to the cent on rounded figures", () => {
    const out = sumChainTvl(1, [
      { user: "0xA", collateralValueInLoan: new BigNumber("100.005"), debtInLoan: new BigNumber("33.335"), loanPriceUsd: new BigNumber("0.999") },
      { user: "0xa", collateralValueInLoan: new BigNumber("0.333"), debtInLoan: new BigNumber("0.111"), loanPriceUsd: new BigNumber(1) },
    ]);
    expect(new BigNumber(out.tvlUsd).plus(out.borrowedUsd).toFixed(2)).toBe(new BigNumber(out.grossTvlUsd).toFixed(2));
    expect(out.users).toBe(1); // same wallet, case-insensitive
    expect(out.positions).toBe(2);
  });

  it("aggregateTvl: total sums chains, asOf = oldest, stale = any", () => {
    const out = aggregateTvl([
      { chainId: 1, asOf: "2026-09-10T10:05:00.000Z", stale: false, tvlUsd: 256, grossTvlUsd: 1060, borrowedUsd: 804, positions: 2, users: 2 },
      { chainId: 4663, asOf: "2026-09-10T10:00:00.000Z", stale: true, tvlUsd: 10.5, grossTvlUsd: 30.25, borrowedUsd: 19.75, positions: 1, users: 1 },
    ]);
    expect(out.asOf).toBe("2026-09-10T10:00:00.000Z");
    expect(out.stale).toBe(true);
    expect(out.total).toEqual({ tvlUsd: 266.5, grossTvlUsd: 1090.25, borrowedUsd: 823.75, positions: 3, users: 3 });
    expect(out.chains).toHaveLength(2);
  });
});

describe("GET /v1/tvl", () => {
  it("503 not_ready until a chain has been computed — never a 200 with zeros", async () => {
    const res = await app.request("/v1/tvl");
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe("not_ready");
  });

  it("serves the primed chains (partial prime = only those chains) with the aggregate on top", async () => {
    rawStore.setOk(KEYS.tvl(CHAIN), { chainId: CHAIN, tvlUsd: 256, grossTvlUsd: 1060, borrowedUsd: 804, positions: 2, users: 2 }, 900);
    const res = await app.request("/v1/tvl");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0]).toMatchObject({ chainId: CHAIN, stale: false, tvlUsd: 256, grossTvlUsd: 1060, borrowedUsd: 804, positions: 2, users: 2 });
    expect(typeof body.chains[0].asOf).toBe("string");
    expect(body.asOf).toBe(body.chains[0].asOf);
    expect(body.stale).toBe(false);
    expect(body.total).toEqual({ tvlUsd: 256, grossTvlUsd: 1060, borrowedUsd: 804, positions: 2, users: 2 });
  });
});
