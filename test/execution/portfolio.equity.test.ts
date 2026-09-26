// Equity vaults in the ops portfolio: the vault card is built from the stock leg with the whole-vault
// P&L (EquityPositionCard), its yield loop leaves the plain list, the deposit is reconstructed the
// way utils/equityPosition.ts does when no row recorded it, and a closed vault is re-skinned from its
// row's tag. Seeds the real composer like equity.exit.test.ts so the vault market is the real one.
import { vi, describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";

vi.hoisted(() => {
  process.env.EQUITY_VAULTS_ENABLED = "true";
});
vi.mock("../../src/sources/onchain.ts", () => ({ getClient: vi.fn(), isStUSDS: () => false, isSpUSDG: () => false, isWsNET: () => false }));
vi.mock("../../src/sources/http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sources/http.ts")>()),
  getJson: vi.fn(async () => []),
}));

import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readMarkets } from "../../src/data/markets.ts";
import { equityVaultsFor } from "../../src/data/equityVaults.ts";
import { getClient } from "../../src/sources/onchain.ts";
import { getJson } from "../../src/sources/http.ts";
import { SWAP_FEE_BPS, NON_CORRELATED_SWAP_FEE_BPS } from "../../src/execution/swap.ts";
import { buildWalletPortfolio, type PortfolioDbRow } from "../../src/execution/portfolio.ts";

const CHAIN = 4663;
const USER = "0x2222222222222222222222222222222222222222";
const PROXY0 = "0x3333333333333333333333333333333333333330";
const PROXY1 = "0x3333333333333333333333333333333333333331";
const PROXY2 = "0x3333333333333333333333333333333333333332";
const STOCK_PRICE = 200;
const STOCK_COLLATERAL = 49_500_000_000_000_000_000n; // 49.5 SPY
const STOCK_DEBT = 4_960_000_000n; // 4,960 USDG
const NOW = Date.UTC(2026, 8, 26, 12);
const spy = () => equityVaultsFor(CHAIN).find((v) => v.stock.symbol === "SPY")!;
const close = (actual: string | number, expected: number, digits = 4) => expect(Number(actual)).toBeCloseTo(expected, digits);

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

// Loop 0 = the SPY vault's yield leg (basis 4,950 = the stock borrow), loop 1 = a standalone syrupUSDG
// loop, loop 2 = a CLOSED loop. Stock leg under the user: 49.5 SPY, 4,960 USDG debt.
function mockChain() {
  const yieldId = spy().yieldMarketId;
  const loops = [
    { open: true, marketId: yieldId, userProxy: PROXY0, amountDepositedInLoanToken: 4_950_000_000n, amountReturnedInLoanToken: 0n },
    { open: true, marketId: yieldId, userProxy: PROXY1, amountDepositedInLoanToken: 1_000_000_000n, amountReturnedInLoanToken: 0n },
    { open: false, marketId: yieldId, userProxy: PROXY2, amountDepositedInLoanToken: 0n, amountReturnedInLoanToken: 5_100_000_000n },
  ];
  const morphoPos = (args: any[]) => {
    const who = String(args[0]).toLowerCase();
    if (who === PROXY0.toLowerCase()) return { supplyShares: 0n, borrowShares: 10n, collateral: 49_500_000_000n };
    if (who === PROXY1.toLowerCase()) return { supplyShares: 0n, borrowShares: 20n, collateral: 10_000_000_000n };
    if (who === PROXY2.toLowerCase()) return { supplyShares: 0n, borrowShares: 0n, collateral: 0n };
    const coll = String(args[1].collateralToken).toLowerCase() === spy().stock.address.toLowerCase() ? STOCK_COLLATERAL : 0n;
    return { supplyShares: 0n, borrowShares: coll > 0n ? 1n : 0n, collateral: coll };
  };
  const sharesValue = (args: any[]) => {
    const shares = BigInt(args[1]);
    if (shares === 10n) return 44_550_000_000n;
    if (shares === 20n) return 9_000_000_000n;
    if (shares === 1n) return STOCK_DEBT;
    return 0n;
  };
  const byFn = (fn: string, args: any[]) => {
    switch (fn) {
      case "getUserLeveragePositions": return loops;
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

const row = (index: number, over: Partial<PortfolioDbRow> = {}): PortfolioDbRow => ({
  positionId: `${USER}-${spy().yieldMarketId}-${index}`,
  user: USER,
  chainId: CHAIN,
  open: true,
  amountDepositedInUsd: 1000,
  desiredLtv: 90,
  createdAt: new Date(NOW - 10 * 86_400_000).toISOString(),
  updatedAt: new Date(NOW - 10 * 86_400_000).toISOString(),
  ...over,
});

beforeEach(() => {
  vi.mocked(getClient).mockReset();
  vi.mocked(getJson).mockReset().mockResolvedValue([]);
  seed();
  mockChain();
});

describe("equity vault in the portfolio", () => {
  it("folds the basis-matched loop into a vault card built from the stock leg with the whole-vault P&L", async () => {
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [], nowMs: NOW });

    expect(w.equityPositions).toHaveLength(1);
    expect(w.positions.map((p) => p.id)).toEqual([1]); // the standalone loop only
    const v = w.equityPositions[0];
    expect(v.strategyId).toBe(spy().id);
    expect(v.stockSymbol).toBe("SPY");
    expect(v.curator).toBe("Longbow");
    expect(v.yieldLoopIds).toEqual([0]);
    expect(v.yieldLoopMatch).toBe("basis");
    expect(v.yieldSink).toMatch(/^syrupUSDG/);
    expect(v.dbDrift).toEqual(["no_db_row"]);
    expect(v.market.equityVault).toBe(true);
    expect(v.market.links.externalKind).toBe("longbow");

    // Stock leg: 49.5 × $200 = 9,900 collateral, 4,960 debt → 50.10% LTV
    expect(v.stock.collateral).toBe("49.5");
    close(v.stock.collateralUsd, 9900);
    close(v.stock.debtUsdg, 4960);
    expect(v.stock.ltvPct).toBe("50.10");
    expect(v.stock.liqLtvPct).toBe("62.50");
    close(v.stock.liquidationPriceUsd, (50.1 / 62.5) * 200);

    // No row: the deposit is rebuilt by running the entry backwards from the loop's 4,950 basis.
    const target = spy().targetLtvPct / 100;
    const expectedDeposit = 4950 / (1 - SWAP_FEE_BPS / 10000) / target / 0.99 / (1 - NON_CORRELATED_SWAP_FEE_BPS / 10000);
    close(v.depositedUsd, expectedDeposit);
    // Total value = (9,900 − 4,960) stock net + (49,500 − 44,550) yield-leg net = 9,890
    close(v.totalValueUsd, 9890);
    close(v.profitUsd, 9890 - expectedDeposit);
    close(v.yieldLegUsd, 9890 - 9900);

    // The standard row, driven by the stock leg (EquityPositionCard's displayPos).
    expect(v.view.amountDeposited.source).toBe("db");
    close(v.view.amountDeposited.usd, expectedDeposit);
    expect(v.view.totalSupplied.label).toBe("Total Supplied");
    expect(v.view.totalSupplied.collateral).toBe("49.5");
    expect(v.view.totalSupplied.leverage).toBeNull(); // no Nx on a vault
    close(v.view.borrowed.loanToken, 4960);
    expect(v.view.ltv).toEqual({ pct: "50.10", liqPct: "62.50" });
    expect(v.view.price!.current).toBe("200");
    expect(v.view.price!.breakEven).toBeNull();
    expect(v.view.projectedYield).not.toBeNull();
    close(v.view.projectedYield!.yieldGenerated.usd, Math.max(9890 - expectedDeposit, 0));
    close(v.yield.totalUsd, 9890 - expectedDeposit);

    // Header: the vault counts once, at its deposit; the standalone loop at its basis.
    expect(w.header.openCount).toBe(2);
    close(w.header.totalDepositedUsd, expectedDeposit + 1000);
  });

  it("uses the row's recorded deposit and tag when present, and re-skins a closed tagged loop as the vault", async () => {
    const rows = [row(0, { amountDepositedInUsd: 9800, equityMarketId: spy().id }), row(1), row(2, { open: false, amountDepositedInUsd: 5000, amountReturnedInUsd: 5100, equityMarketId: spy().id })];
    const w = await buildWalletPortfolio(CHAIN, USER, { rows, nowMs: NOW });

    const v = w.equityPositions[0];
    expect(v.yieldLoopMatch).toBe("tagged");
    expect(v.depositedUsd).toBe("9800");
    expect(v.dbDrift).toEqual([]);
    expect(v.openedAt).toBe(rows[0].createdAt);

    expect(w.closed).toHaveLength(1);
    const c = w.closed[0];
    expect(c.status).toBe("closed");
    expect(c.market.project).toBe("SPY"); // titled as the vault, not the syrupUSDG loop
    expect(c.market.equityVault).toBe(true);
    expect(c.market.collateralSymbol).toBe("SPY");
    expect(c.view.closed!.amountDeposited).toEqual({ loanToken: "5000", usd: "5000", source: "db" });
    close(c.view.closed!.amountReturned.usd, 5100);
    close(c.yield.totalUsd, 100);
  });
});
