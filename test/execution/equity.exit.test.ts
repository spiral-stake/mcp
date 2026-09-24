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

import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readMarkets, readAddresses } from "../../src/data/markets.ts";
import { equityVaultsFor } from "../../src/data/equityVaults.ts";
import { composeSnapshot } from "../../src/core/compose.ts";
import { getClient } from "../../src/sources/onchain.ts";
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
function mockChain(over: { stockDebt?: bigint; stockCollateral?: bigint } = {}) {
  const yieldId = spy().yieldMarketId;
  const loops = [
    { open: true, marketId: yieldId, userProxy: PROXY0, amountDepositedInLoanToken: 4_950_000_000n, amountReturnedInLoanToken: 0n },
    { open: true, marketId: yieldId, userProxy: PROXY1, amountDepositedInLoanToken: 1_000_000_000n, amountReturnedInLoanToken: 0n },
  ];
  const morphoPos = (args: any[]) => {
    const who = String(args[0]).toLowerCase();
    if (who === PROXY0.toLowerCase()) return { supplyShares: 0n, borrowShares: 10n, collateral: 49_500_000_000n }; // 49,500 syrupUSDG
    if (who === PROXY1.toLowerCase()) return { supplyShares: 0n, borrowShares: 20n, collateral: 10_000_000_000n };
    // the user directly = a stock leg; only the SPY market has one
    const coll = String(args[1].collateralToken).toLowerCase() === spy().stock.address.toLowerCase() ? (over.stockCollateral ?? STOCK_COLLATERAL) : 0n;
    return { supplyShares: 0n, borrowShares: coll > 0n ? 1n : 0n, collateral: coll };
  };
  const sharesValue = (args: any[]) => {
    const shares = BigInt(args[1]);
    if (shares === 10n) return 44_550_000_000n; // loop 0 debt
    if (shares === 20n) return 9_000_000_000n; // loop 1 debt
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
  seed();
  mockChain();
});

describe("matchVaultYieldLoops", () => {
  const L = (basis: string) => ({ amountDepositedInLoanToken: basis });
  it("picks the loop (or subset) whose basis sits in (0.85, 1.02] × the stock debt, closest to it", () => {
    expect(matchVaultYieldLoops([L("4950"), L("1000")], BigNumber(4960))).toEqual([L("4950")]);
    expect(matchVaultYieldLoops([L("2000"), L("2950"), L("100")], BigNumber(4960))).toEqual([L("2000"), L("2950")]); // stacked opens
    expect(matchVaultYieldLoops([L("1000")], BigNumber(4960))).toEqual([]); // nothing plausible
    expect(matchVaultYieldLoops([L("6000")], BigNumber(4960))).toEqual([]); // a basis can't exceed its borrow
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
    expect(positions.map((p) => p.id)).toEqual([1]);
    // stock leg: 49.5 SPY × $200 = $9,900 collateral, 4,960 debt → 50.10% LTV, liquidates at $200 × 50.10/62.5
    expect(v.stock).toMatchObject({ symbol: "SPY", collateral: "49.500000", collateralUsd: "9900.00", debtUsdg: "4960.000000", ltvPct: "50.10", liquidationLtvPct: "62.50", ltvHeadroomPct: "12.40" });
    expect(v.stock.liquidationPriceUsd).toBe(BigNumber(200).multipliedBy(BigNumber(4960).div(9900)).div(0.625).toFixed(4)); // unrounded LTV
    // net value = stock equity (9,900 − 4,960) + loop 0 equity (49,500 − 44,550)
    expect(v.netValueUsd).toBe("9890.00");
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
    // ≈ (9,900 − 4,960) stock + (49,500 − 44,550) loop
    expect(bundle.meta.estimatedUsdgOut).toBe("9890.00");
  });

  it("refuses a debt-free stock leg (equityExit flash-loans the debt) and a wallet with no vault", async () => {
    mockChain({ stockDebt: 0n });
    await expect(buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER })).rejects.toThrow(/no matching|has no debt|No open SPY equity vault/);
    mockChain({ stockCollateral: 0n });
    await expect(buildEquityExitTx({ chainId: CHAIN, strategyId: spy().id, userAddress: USER })).rejects.toThrow(/No open SPY equity vault/);
  });
});
