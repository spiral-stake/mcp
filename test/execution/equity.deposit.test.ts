// Fund-path parity for the equity-vault deposit builder against the app's utils/equityVaultTx.ts:
// the 4-call batch and its order, every equityEntry field, the per-leg fee rates and swap receivers,
// the stock-LTV cap (refused, never clamped), the router's LTV bound, and the two liquidity guards.
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
import { calcFlashLoanAmount } from "../../src/core/leverage.ts";
import { getSwapData } from "../../src/execution/swap.ts";
import { simulateEquityDeposit, buildEquityDepositTx, EQUITY_ROUTER_ABI, MORPHO_AUTH_ABI, maxStockLtvPct } from "../../src/execution/equity.ts";

// The equityEntry params tuple, for narrowing decoded calldata (decodeFunctionData returns the ABI's union).
const decodeEntry = (p: {
  depositToken: string; amountIn: bigint; stockMinOut: bigint; stockMarketId: string; stockBorrowAmount: bigint; yieldMinOut: bigint;
  leverageParams: { marketId: string; amountCollateral: bigint; amountFlashLoan: bigint; minTokenOut: bigint };
}) => p;

const CHAIN = 4663;
const USER = "0x2222222222222222222222222222222222222222";
const STOCK_PRICE = 200; // USD per SPY in the seed
const spy = () => equityVaultsFor(CHAIN).find((v) => v.stock.symbol === "SPY")!;

function seed(over: { stockLiquidityRaw?: string; yieldLiquidityRaw?: bigint } = {}) {
  const markets = readMarkets(CHAIN);
  const morpho = Object.fromEntries(
    markets.map((m) => [
      m.morphoMarketId,
      {
        borrowApy: "4.00", quarterlyBorrowApy: "4.00",
        supplyAssets: new BigNumber(1_000_000), supplyAssetsUsd: 1_000_000,
        liquidityAssetsParsed: over.yieldLiquidityRaw ?? 100_000_000_000n, liquidityAssets: new BigNumber(100_000), liquidityAssetsUsd: 100_000,
        paLiquidityAssets: new BigNumber(100_000), paSharedLiquidity: [], curators: [],
      },
    ]),
  );
  rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 900);
  rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), Object.fromEntries(markets.map((m) => [m.morphoMarketId, new BigNumber(1)])), 900);
  rawStore.setOk(KEYS.prices(CHAIN), {}, 900);
  const equityRaw = Object.fromEntries(
    equityVaultsFor(CHAIN).map((v) => [
      v.stockMarketId,
      { borrowApyPct: "6.00", liquidityUsd: 100_000, liquidityAssetsParsed: over.stockLiquidityRaw ?? "100000000000", supplyUsd: 500_000, stockPriceUsd: STOCK_PRICE },
    ]),
  );
  rawStore.setOk(KEYS.equityMarkets(CHAIN), equityRaw, 900);
}

// Quote mock: USDG -> stock at the seed price (18 dp), USDG -> yield collateral 1:1 (6 dp).
const STOCK_ADDR = () => spy().stock.address.toLowerCase();
function mockQuotes() {
  vi.mocked(getSwapData).mockImplementation(async (_chain, _isPt, _receiver, _tokenIn, tokenOut, amountIn) => {
    const inRaw = BigInt(amountIn);
    const amountOut = tokenOut.toLowerCase() === STOCK_ADDR() ? (inRaw * 10n ** 18n) / (BigInt(STOCK_PRICE) * 10n ** 6n) : inRaw;
    return { swapData: { extRouter: "0x0000000000000000000000000000000000000001", extCalldata: "0x01" }, amountOut, source: "KyberSwap" as const };
  });
}

beforeEach(() => {
  vi.mocked(getSwapData).mockReset();
  seed();
  mockQuotes();
});

describe("buildEquityDepositTx — batch + equityEntry parity", () => {
  it("emits [approve, authorize, equityEntry, revoke] with every field sized as the app does", async () => {
    const bundle = await buildEquityDepositTx({ chainId: CHAIN, strategyId: spy().id, amount: "10000", userAddress: USER });
    const { equityRouterAddress, flashLeverageAddress } = readAddresses(CHAIN) as unknown as { equityRouterAddress: string; flashLeverageAddress: string };
    const yieldMarket = composeSnapshot(CHAIN).markets.map((m) => m.market).find((m) => m.morphoMarketId.toLowerCase() === spy().yieldMarketId.toLowerCase())!;
    const usdg = spy().loanToken;

    expect(bundle.action).toBe("equity_deposit");
    expect(bundle.atomic).toBe(true);
    expect(bundle.calls).toHaveLength(4);

    // 1. approve USDG -> equity router for exactly the deposit
    expect(bundle.calls[0].to).toBe(usdg.address);
    const approve = decodeFunctionData({ abi: [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }], data: bundle.calls[0].data as `0x${string}` });
    expect(approve.args).toEqual([equityRouterAddress, 10_000_000_000n]);
    // 2. authorize router on Morpho … 4. revoke
    for (const [i, on] of [[1, true], [3, false]] as const) {
      expect(bundle.calls[i].to).toBe(spy().morpho);
      expect(decodeFunctionData({ abi: MORPHO_AUTH_ABI, data: bundle.calls[i].data as `0x${string}` }).args).toEqual([equityRouterAddress, on]);
    }
    // 3. equityEntry
    expect(bundle.calls[2].to).toBe(equityRouterAddress);
    const { functionName, args } = decodeFunctionData({ abi: EQUITY_ROUTER_ABI, data: bundle.calls[2].data as `0x${string}` });
    expect(functionName).toBe("equityEntry");
    const p = (args as unknown as [Parameters<typeof decodeEntry>[0]])[0];
    // 10,000 USDG -> 50 SPY quoted; min-out at 1% = 49.5 SPY; borrow 50% of 49.5 × $200 = 4,950 USDG
    expect(p.depositToken).toBe(usdg.address);
    expect(p.amountIn).toBe(10_000_000_000n);
    expect(p.stockMinOut).toBe(49_500_000_000_000_000_000n);
    expect(p.stockMarketId).toBe(spy().stockMarketId);
    expect(p.stockBorrowAmount).toBe(4_950_000_000n);
    // zap 4,950 USDG -> 4,950 syrupUSDG (1:1 mock); yieldMinOut at 1%; flash loan at the yield market's safeLtv
    expect(p.yieldMinOut).toBe(4_900_500_000n);
    expect(p.leverageParams.marketId).toBe(yieldMarket.morphoMarketId);
    expect(p.leverageParams.amountCollateral).toBe(0n); // recomputed on-chain from the router's post-zap balance
    expect(p.leverageParams.amountFlashLoan).toBe(calcFlashLoanAmount(yieldMarket.safeLtv, yieldMarket, "4950"));
    expect(p.leverageParams.minTokenOut).toBe((p.leverageParams.amountFlashLoan * 99n) / 100n);

    // Swap legs: stock (25 bps, to the router), zap (5 bps, to the router), loop (5 bps, to the core).
    const quotes = vi.mocked(getSwapData).mock.calls;
    expect(quotes).toHaveLength(3);
    expect([quotes[0][2], quotes[0][7]]).toEqual([equityRouterAddress, 25]);
    expect([quotes[1][2], quotes[1][7]]).toEqual([equityRouterAddress, 5]);
    expect([quotes[2][2], quotes[2][7]]).toEqual([flashLeverageAddress, 5]);
    expect(quotes[2][5]).toBe(p.leverageParams.amountFlashLoan);

    expect(bundle.meta.signingUrl).toContain(`/${CHAIN}/strategies/${spy().id}?`);
    expect(bundle.meta.instructions).toContain("atomic");
  });

  it("previews the stock liquidation price and net APY at the chosen LTV", async () => {
    const { preview } = await simulateEquityDeposit({ chainId: CHAIN, strategyId: spy().id, amount: "10000" });
    expect(preview.stock.ltvPct).toBe("50.00");
    expect(preview.stock.maxLtvPct).toBe("55.00");
    expect(preview.stock.liquidationPriceUsd).toBe("160.0000"); // 200 × 50 / 62.5
    expect(preview.stock.priceDropToLiquidationPct).toBe("20.00");
    expect(preview.stock.borrowUsdg).toBe("4950.00");
    expect(preview.yieldLeg.collateralIn).toBe("4950.000000");
    expect(preview.fees).toMatchObject({ stockLegBps: 25, yieldLegBps: 5 });
    // netApy = ltv × (yieldLegApy − stockBorrowApy), the read-API's own formula
    const ev = composeSnapshot(CHAIN) && (await simulateEquityDeposit({ chainId: CHAIN, strategyId: spy().id, amount: "1" })).preview; // any call; ev facts identical
    expect(preview.netApyPct).toBe(BigNumber(0.5).multipliedBy(BigNumber(ev.yieldLeg.leverageApyPct).minus("6.00")).toFixed(2));
    expect(preview.slippage).toBe(0.01);
  });

  it("borrows at a chosen LTV up to the cap, and refuses (never clamps) above it", async () => {
    const at55 = await buildEquityDepositTx({ chainId: CHAIN, strategyId: spy().id, amount: "10000", userAddress: USER, stockLtvPct: "55" });
    const p = (decodeFunctionData({ abi: EQUITY_ROUTER_ABI, data: at55.calls[2].data as `0x${string}` }).args as unknown as [Parameters<typeof decodeEntry>[0]])[0];
    expect(p.stockBorrowAmount).toBe(5_445_000_000n); // 49.5 × 200 × 0.55
    expect(maxStockLtvPct(composeSnapshot(CHAIN) && { liqLtvPct: "62.50" } as any)).toBe(55);
    await expect(buildEquityDepositTx({ chainId: CHAIN, strategyId: spy().id, amount: "10000", userAddress: USER, stockLtvPct: "55.01" })).rejects.toThrow(/55\.01% is above the 55\.00% cap/);
    await expect(simulateEquityDeposit({ chainId: CHAIN, strategyId: spy().id, amount: "10000", stockLtvPct: "0" })).rejects.toThrow(/positive percent/);
  });

  it("refuses when the stock market cannot lend the borrow, or the yield market cannot fund the flash loop", async () => {
    seed({ stockLiquidityRaw: "1000000000" }); // 1,000 USDG borrowable on the stock market
    await expect(simulateEquityDeposit({ chainId: CHAIN, strategyId: spy().id, amount: "10000" })).rejects.toThrow(/has only 1000\.00 USDG available to borrow; this deposit needs 4950\.00/);
    seed({ yieldLiquidityRaw: 1_000_000_000n }); // 1,000 USDG borrowable on the yield market
    await expect(simulateEquityDeposit({ chainId: CHAIN, strategyId: spy().id, amount: "10000" })).rejects.toThrow(/yield market has 1000\.00 USDG borrowable/);
  });

  it("rejects a loop id and an unknown id with distinct messages", async () => {
    await expect(simulateEquityDeposit({ chainId: CHAIN, strategyId: spy().yieldMarketId, amount: "10" })).rejects.toThrow(/leverage strategy, not an equity vault/);
    await expect(simulateEquityDeposit({ chainId: CHAIN, strategyId: "equity-0xnope", amount: "10" })).rejects.toThrow(/Unknown equity vault/);
    await expect(simulateEquityDeposit({ chainId: CHAIN, strategyId: spy().id, amount: "0" })).rejects.toThrow(/positive number/);
  });
});
