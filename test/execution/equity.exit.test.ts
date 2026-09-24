// Equity vault positions + exit, on chain facts alone: a vault's yield loop is recognised by its
// deposit basis matching the stock debt (as the app's fallback when no dashboard row exists), it is
// removed from the plain positions list, `build_manage_tx` refuses to touch it, and the exit batch
// closes it then unwinds the stock leg with the app's minLoanOut floor.
import { vi, describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";
import { decodeFunctionData } from "viem";

vi.hoisted(() => {
  process.env.EQUITY_VAULTS_ENABLED = "true";
});
vi.mock("../../src/core/freshness.ts", () => ({ assertMarketDataFresh: vi.fn() }));
vi.mock("../../src/sources/onchain.ts", () => ({ getClient: vi.fn(), isStUSDS: () => false, isSpUSDG: () => false, isWsNET: () => false }));
vi.mock("../../src/execution/swap.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/execution/swap.ts")>()),
  getSwapData: vi.fn(),
}));
// The dashboard's per-user rows (open-time vault tags). Default: no rows.
vi.mock("../../src/sources/http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sources/http.ts")>()),
  getJson: vi.fn(async () => []),
}));

import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readMarkets, readAddresses } from "../../src/data/markets.ts";
import { equityVaultsFor } from "../../src/data/equityVaults.ts";
import { composeSnapshot } from "../../src/core/compose.ts";
import { getClient } from "../../src/sources/onchain.ts";
import { getJson } from "../../src/sources/http.ts";
import { getSwapData } from "../../src/execution/swap.ts";
import { getUserEquityPositions, buildEquityExitTx, matchVaultYieldLoops, assertNotVaultYieldLeg, EQUITY_ROUTER_ABI, MORPHO_AUTH_ABI } from "../../src/execution/equity.ts";

const CHAIN = 4663;
const USER = "0x2222222222222222222222222222222222222222";
const PROXY0 = "0x3333333333333333333333333333333333333330";
const PROXY1 = "0x3333333333333333333333333333333333333331";
const STOCK_PRICE = 200;
const spy = () => equityVaultsFor(CHAIN).find((v) => v.stock.symbol === "SPY")!;

function seed() {
  const markets = readMarkets(CHAIN);
  rawStore.setOk(KEYS.morphoMarkets(CHAIN), Object.fromEntries(markets.map((m) => [m.morphoMarketId, {
    borrowApy: "4.00", quarterlyBorrowApy: "4.00", supplyAssets: new BigNumber(1_000_000), supplyAssetsUsd: 1_000_000,
    liquidityAssetsParsed: 50_000_000_000n, liquidityAssets: new BigNumber(50_000), liquidityAssetsUsd: 50_000,
    paLiquidityAssets: new BigNumber(50_000), paSharedLiquidity: [], curators: [],
  }])), 900);
  rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), Object.fromEntries(markets.map((m) => [m.morphoMarketId, new BigNumber(1)])), 900);
  rawStore.setOk(KEYS.prices(CHAIN), {}, 900);
  rawStore.setOk(KEYS.equityMarkets(CHAIN), Object.fromEntries(equityVaultsFor(CHAIN).map((v) => [v.stockMarketId, { borrowApyPct: "6.00", liquidityUsd: 100_000, liquidityAssetsParsed: "100000000000", supplyUsd: 500_000, stockPriceUsd: STOCK_PRICE }])), 900);
}

// Chain state: loop 0 = the SPY vault's yield leg (basis 4,950 USDG = the stock borrow), loop 1 = a
// standalone syrupUSDG loop (basis 1,000). Stock leg: 49.5 SPY collateral, 4,960 USDG debt (accrued).
const STOCK_COLLATERAL = 49_500_000_000_000_000_000n;
const STOCK_DEBT = 4_960_000_000n;
const PROXY2 = "0x3333333333333333333333333333333333333332";
// Loop 2 (optional): an UNRELATED syrupUSDG loop whose basis (4,900) also lands in the vault's window.
function mockChain(over: { stockDebt?: bigint; stockCollateral?: bigint; withLookalike?: boolean } = {}) {
  const yieldId = spy().yieldMarketId;
  const loops = [
    { open: true, marketId: yieldId, userProxy: PROXY0, amountDepositedInLoanToken: 4_950_000_000n, amountReturnedInLoanToken: 0n },
    { open: true, marketId: yieldId, userProxy: PROXY1, amountDepositedInLoanToken: 1_000_000_000n, amountReturnedInLoanToken: 0n },
    ...(over.withLookalike ? [{ open: true, marketId: yieldId, userProxy: PROXY2, amountDepositedInLoanToken: 4_900_000_000n, amountReturnedInLoanToken: 0n }] : []),
  ];
  const morphoPos = (args: any[]) => {
    const who = String(args[0]).toLowerCase();
    if (who === PROXY0.toLowerCase()) return { supplyShares: 0n, borrowShares: 10n, collateral: 49_500_000_000n }; // 49,500 syrupUSDG
    if (who === PROXY1.toLowerCase()) return { supplyShares: 0n, borrowShares: 20n, collateral: 10_000_000_000n };
    if (who === PROXY2.toLowerCase()) return { supplyShares: 0n, borrowShares: 30n, collateral: 49_000_000_000n };
    // the user directly = a stock leg; only the SPY market has one
    const coll = String(args[1].collateralToken).toLowerCase() === spy().stock.address.toLowerCase() ? (over.stockCollateral ?? STOCK_COLLATERAL) : 0n;
    return { supplyShares: 0n, borrowShares: coll > 0n ? 1n : 0n, collateral: coll };
  };
  const sharesValue = (args: any[]) => {
    const shares = BigInt(args[1]);
    if (shares === 10n) return 44_550_000_000n; // loop 0 debt
    if (shares === 20n) return 9_000_000_000n; // loop 1 debt
    if (shares === 30n) return 44_100_000_000n; // loop 2 debt
    if (shares === 1n) return over.stockDebt ?? STOCK_DEBT;
    return 0n;
  };
  const byFn = (fn: string, args: any[]) => {
    switch (fn) {
      case "getUserLeveragePositions": return loops;
      case "getUserLeveragePosition": return loops[Number(args[1])];
      case "getMorphoPosition": return morphoPos(args);
      case "getSharesValueInLoanToken": return sharesValue(args);
      default: throw new Error(`unmocked ${fn}`);
    }
  };
  vi.mocked(getClient).mockReturnValue({
    readContract: vi.fn(async ({ functionName, args }: any) => byFn(functionName, args)),
    multicall: vi.fn(async ({ contracts }: any) => contracts.map((c: any) => byFn(c.functionName, c.args))),
  } as any);
}

beforeEach(() => {
  vi.mocked(getClient).mockReset();
  vi.mocked(getSwapData).mockReset();
  vi.mocked(getJson).mockReset().mockResolvedValue([]);
  seed();
  mockChain();
});

describe("matchVaultYieldLoops", () => {
  const L = (basis: string) => ({ amountDepositedInLoanToken: basis });
  it("claims the ONE loop (or subset) whose basis sits in (0.85, 1.02] × the stock debt", () => {
    expect(matchVaultYieldLoops([L("4950"), L("1000")], BigNumber(4960))).toEqual({ loops: [L("4950")], match: "basis", ambiguous: [] });
    expect(matchVaultYieldLoops([L("2000"), L("2950"), L("100")], BigNumber(4960))).toEqual({ loops: [L("2000"), L("2950")], match: "basis", ambiguous: [] }); // stacked opens
    expect(matchVaultYieldLoops([L("1000")], BigNumber(4960))).toEqual({ loops: [], match: "none", ambiguous: [] }); // nothing plausible
    expect(matchVaultYieldLoops([L("6000")], BigNumber(4960))).toEqual({ loops: [], match: "none", ambiguous: [] }); // a basis can't exceed its borrow
  });
  it("claims NOTHING when more than one loop could be the leg — reports them as ambiguous", () => {
    const a = L("4950"), b = L("4900");
    expect(matchVaultYieldLoops([a, b, L("1000")], BigNumber(4960))).toEqual({ loops: [], match: "ambiguous", ambiguous: [a, b] });
  });
  it("does not let a dust loop riding along with a real match make it ambiguous", () => {
    // {2000, 2950} explains the debt; {2000, 2950, 100} also fits the window but needs nothing the
    // smaller subset lacks — only the minimal explanation counts, and it is unique.
    expect(matchVaultYieldLoops([L("2000"), L("2950"), L("100")], BigNumber(4960))).toEqual({ loops: [L("2000"), L("2950")], match: "basis", ambiguous: [] });
  });
  it("takes tagged loops outright and only basis-matches the residual", () => {
    const tagged = L("4950");
    expect(matchVaultYieldLoops([tagged, L("4900")], BigNumber(4960), [tagged])).toEqual({ loops: [tagged], match: "tagged", ambiguous: [] });
    // tagged loop covers only part of the debt → the rest is basis-matched (stacked open before tags existed)
    const t2 = L("2000");
    expect(matchVaultYieldLoops([t2, L("2950"), L("100")], BigNumber(4960), [t2])).toEqual({ loops: [t2, L("2950")], match: "mixed", ambiguous: [] });
  });
});

describe("getUserEquityPositions", () => {
  it("attributes the basis-matched loop to the vault and removes it from the plain list", async () => {
    const { equityPositions, positions } = await getUserEquityPositions(CHAIN, USER);
    expect(equityPositions).toHaveLength(1);
    const v = equityPositions[0];
    expect(v.strategyId).toBe(spy().id);
    expect(v.curator).toBe("Longbow");
    expect(v.yieldLoops.map((l) => l.id)).toEqual([0]);
    expect(v.yieldLoopMatch).toBe("basis");
    expect(v).not.toHaveProperty("ambiguousYieldLoopIds");
    expect(positions.map((p) => p.id)).toEqual([1]);
    // stock leg: 49.5 SPY × $200 = $9,900 collateral, 4,960 debt → 50.10% LTV, liquidates at $200 × 50.10/62.5
    expect(v.stock).toMatchObject({ symbol: "SPY", collateral: "49.500000", collateralUsd: "9900.00", debtUsdg: "4960.000000", ltvPct: "50.10", liquidationLtvPct: "62.50", ltvHeadroomPct: "12.40" });
    expect(v.stock.liquidationPriceUsd).toBe(BigNumber(200).multipliedBy(BigNumber(4960).div(9900)).div(0.625).toFixed(4)); // unrounded LTV
    // net value = stock equity (9,900 − 4,960) + loop 0 equity (49,500 − 44,550)
    expect(v.netValueUsd).toBe("9890.00");
  });

  it("claims nothing when a look-alike loop also fits the window: ambiguous, candidates stay in the plain list", async () => {
    mockChain({ withLookalike: true });
    const { equityPositions, positions } = await getUserEquityPositions(CHAIN, USER);
    expect(equityPositions).toHaveLength(1);
    expect(equityPositions[0].yieldLoopMatch).toBe("ambiguous");
    expect(equityPositions[0].yieldLoops).toEqual([]);
    expect(equityPositions[0].ambiguousYieldLoopIds!.sort()).toEqual([0, 2]);
    expect(positions.map((p) => p.id).sort()).toEqual([0, 1, 2]);
  });

  it("uses the app's open-time tag as the primary signal, and never claims a loop tagged for another vault", async () => {
    mockChain({ withLookalike: true });
    const yieldId = spy().yieldMarketId;
    // The dashboard says loop 2 is the SPY vault's leg (and loop 0 belongs to NetNet's NVDA vault).
    // positionId is stored exactly as the dashboard writes it: `${user}-${marketId}-${index}`.
    vi.mocked(getJson).mockResolvedValue([
      { positionId: `${USER}-${yieldId}-2`, equityMarketId: spy().id.toUpperCase() },
      { positionId: `${USER}-${yieldId}-0`, equityMarketId: "equity-0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e" },
    ]);
    const { equityPositions, positions } = await getUserEquityPositions(CHAIN, USER);
    const v = equityPositions.find((p) => p.strategyId === spy().id)!;
    expect(v.yieldLoopMatch).toBe("tagged");
    expect(v.yieldLoops.map((l) => l.id)).toEqual([2]);
    expect(positions.map((p) => p.id).sort()).toEqual([0, 1]);
    expect(vi.mocked(getJson).mock.calls[0][0]).toBe(`https://dashboard.spiralstake.xyz/leverage/${USER}?chainId=${CHAIN}`);
  });

  it("degrades to basis matching (never a wrong claim) when the dashboard is down", async () => {
    vi.mocked(getJson).mockRejectedValue(new Error("HTTP 503 from dashboard"));
    const { equityPositions } = await getUserEquityPositions(CHAIN, USER);
    expect(equityPositions[0].yieldLoopMatch).toBe("basis");
    expect(equityPositions[0].yieldLoops.map((l) => l.id)).toEqual([0]);
  });

  it("leaves every loop in the plain list when no vault stock leg is open", async () => {
    mockChain({ stockCollateral: 0n });
    const { equityPositions, positions } = await getUserEquityPositions(CHAIN, USER);
    expect(equityPositions).toEqual([]);
    expect(positions.map((p) => p.id)).toEqual([1, 0]); // newest first, as get_positions
  });
});

describe("assertNotVaultYieldLeg (build_manage_tx guard)", () => {
  const yieldMarket = () => composeSnapshot(CHAIN).markets.map((m) => m.market).find((m) => m.morphoMarketId.toLowerCase() === spy().yieldMarketId.toLowerCase())!;
  it("refuses the vault's yield leg and names the exit tool", async () => {
    await expect(assertNotVaultYieldLeg(CHAIN, USER, 0, yieldMarket())).rejects.toThrow(/Position 0 is the yield leg of your SPY equity vault.*build_equity_exit_tx/s);
  });
  it("allows a standalone loop on the same market", async () => {
    await expect(assertNotVaultYieldLeg(CHAIN, USER, 1, yieldMarket())).resolves.toBeUndefined();
  });
  it("refuses a loop that MIGHT be the leg (ambiguous) — fail closed, and says how to resolve it", async () => {
    mockChain({ withLookalike: true });
    await expect(assertNotVaultYieldLeg(CHAIN, USER, 2, yieldMarket())).rejects.toThrow(/may be the yield leg of your SPY equity vault.*loops 0, 2.*yieldPositionIds/s);
    await expect(assertNotVaultYieldLeg(CHAIN, USER, 1, yieldMarket())).resolves.toBeUndefined(); // not a candidate
  });
  it("never reads chain for a market no vault deploys into", async () => {
    const other = composeSnapshot(CHAIN).markets.map((m) => m.market).find((m) => m.collateralToken.symbol === "spUSDG")!;
    await expect(assertNotVaultYieldLeg(CHAIN, USER, 0, other)).resolves.toBeUndefined();
    expect(vi.mocked(getClient)(CHAIN).readContract).not.toHaveBeenCalled();
    expect(vi.mocked(getClient)(CHAIN).multicall).not.toHaveBeenCalled();
  });
});

describe("buildEquityExitTx", () => {
  beforeEach(() => {
    // syrupUSDG -> USDG 1:1 (6 dp); SPY -> USDG at $200
    vi.mocked(getSwapData).mockImplementation(async (_c, _pt, _recv, tokenIn, _out, amountIn) => {
      const inRaw = BigInt(amountIn);
      const amountOut = tokenIn.toLowerCase() === spy().stock.address.toLowerCase() ? (inRaw * BigInt(STOCK_PRICE) * 10n ** 6n) / 10n ** 18n : inRaw;
      return { swapData: { extRouter: "0x0000000000000000000000000000000000000001", extCalldata: "0x01" }, amountOut, source: "KyberSwap" as const };
    });
  });

  it("emits [deleverage(loop), authorize, equityExit, revoke] with the app's minLoanOut floor and no fees", async () => {
    const bundle = await buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER });
    const { equityRouterAddress, flashLeverageAddress } = readAddresses(CHAIN) as unknown as { equityRouterAddress: string; flashLeverageAddress: string };
    expect(bundle.action).toBe("equity_exit");
    expect(bundle.calls.map((c) => c.to)).toEqual([flashLeverageAddress, spy().morpho, equityRouterAddress, spy().morpho]);

    // deleverage(id 0, ALL collateral, swap, minOut) sized on the loop's exact on-chain collateral
    const del = decodeFunctionData({ abi: [{ type: "function", name: "deleverage", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "tuple", components: [{ name: "extRouter", type: "address" }, { name: "extCalldata", type: "bytes" }] }, { type: "uint256" }], outputs: [] }], data: bundle.calls[0].data as `0x${string}` });
    expect(del.args[0]).toBe(0n);
    expect(del.args[1]).toBe(0n);
    expect(del.args[3]).toBe(49_005_000_000n); // 49,500 × 0.99

    // equityExit: min-out of 49.5 SPY → 9,900 USDG at 1% = 9,801; less the debt × 1.005 (4,984.80) = 4,816.20
    const exit = decodeFunctionData({ abi: EQUITY_ROUTER_ABI, data: bundle.calls[2].data as `0x${string}` });
    expect(exit.functionName).toBe("equityExit");
    const ex = (exit.args as unknown as [{ stockMarketId: string; minLoanOut: bigint }])[0];
    expect(ex.stockMarketId).toBe(spy().stockMarketId);
    expect(ex.minLoanOut).toBe(4_816_200_000n);
    for (const [i, on] of [[1, true], [3, false]] as const) {
      expect(decodeFunctionData({ abi: MORPHO_AUTH_ABI, data: bundle.calls[i].data as `0x${string}` }).args).toEqual([equityRouterAddress, on]);
    }

    // Both exit swaps carry NO fee, sized on the exact raw collateral, delivered to the executing contract.
    const quotes = vi.mocked(getSwapData).mock.calls;
    expect(quotes).toHaveLength(2);
    expect([quotes[0][2], quotes[0][5], quotes[0][7]]).toEqual([flashLeverageAddress, 49_500_000_000n, 0]);
    expect([quotes[1][2], quotes[1][5], quotes[1][7]]).toEqual([equityRouterAddress, STOCK_COLLATERAL, 0]);

    expect(bundle.meta.closedYieldPositionIds).toEqual([0]);
    expect(bundle.meta.yieldLoopSelection).toBe("basis");
    // ≈ (9,900 − 4,960) stock + (49,500 − 44,550) loop
    expect(bundle.meta.estimatedUsdgOut).toBe("9890.00");
  });

  it("refuses an ambiguous vault without yieldPositionIds, and closes exactly the named loop with them", async () => {
    mockChain({ withLookalike: true });
    await expect(buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER })).rejects.toThrow(/Cannot tell which of your syrupUSDG loops \(ids 0, 2\).*yieldPositionIds/s);
    mockChain({ withLookalike: true });
    const bundle = await buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER, yieldPositionIds: [2] });
    expect(bundle.meta.closedYieldPositionIds).toEqual([2]);
    expect(bundle.meta.yieldLoopSelection).toBe("explicit");
    expect(bundle.calls).toHaveLength(4); // one deleverage + authorize + equityExit + revoke
    const quotes = vi.mocked(getSwapData).mock.calls;
    expect(quotes[0][5]).toBe(49_000_000_000n); // loop 2's exact collateral, not loop 0's
  });

  it("validates explicit yieldPositionIds: must be this wallet's open loop on the vault's yield market", async () => {
    await expect(buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER, yieldPositionIds: [99] })).rejects.toThrow(/position 99 is not an open loop/);
    mockChain();
    await expect(buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER, yieldPositionIds: [] })).rejects.toThrow(/at least one/);
  });

  it("refuses a debt-free stock leg (equityExit flash-loans the debt) and a wallet with no vault", async () => {
    mockChain({ stockDebt: 0n });
    await expect(buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER })).rejects.toThrow(/no matching|has no debt|No open SPY equity vault/);
    mockChain({ stockCollateral: 0n });
    await expect(buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER })).rejects.toThrow(/No open SPY equity vault/);
  });
});
