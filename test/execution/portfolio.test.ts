// Parity of the ops portfolio read with the app's Portfolio card (contract-hooks/FlashLeverage
// calcPostionData + utils/positionYield + utils/getNetYieldUsd + LeveragePositionCard's rows). Every
// expected figure below is worked by hand from the app's formulas, so a drift in either port shows.
import { vi, describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";

vi.mock("../../src/sources/onchain.ts", () => ({ getClient: vi.fn(), isStUSDS: () => false, isSpUSDG: () => false, isWsNET: () => false }));
vi.mock("../../src/core/compose.ts", () => ({ composeSnapshot: vi.fn() }));
vi.mock("../../src/data/markets.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/data/markets.ts")>()),
  readAddresses: () => ({ flashLeverageAddress: "0x4444444444444444444444444444444444444444" }),
}));
vi.mock("../../src/sources/http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sources/http.ts")>()),
  getJson: vi.fn(async () => []),
}));
vi.mock("../../src/sources/tvl.ts", () => ({ discoverChainUsers: vi.fn(async () => []) }));

import { getClient } from "../../src/sources/onchain.ts";
import { composeSnapshot } from "../../src/core/compose.ts";
import { getJson } from "../../src/sources/http.ts";
import { discoverChainUsers } from "../../src/sources/tvl.ts";
import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { env } from "../../src/config/env.ts";
import { buildWalletPortfolio, getAllPortfolios, accruedIncentiveUsd, type PortfolioDbRow } from "../../src/execution/portfolio.ts";

const CHAIN = 1;
const USER = "0x2222222222222222222222222222222222222222";
const LOOP_ID = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PERP_ID = "0x3333333333333333333333333333333333333333333333333333333333333333";
const PROXY = "0x3333333333333333333333333333333333333333";
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 12);

const close = (actual: string | number, expected: number, digits = 6) =>
  expect(Number(actual)).toBeCloseTo(expected, digits);

// A correlated loop: collateral worth 1.05 loan tokens, 8% base APY, 4% borrow less a 1% DOLA
// borrow incentive that has been live since the position opened.
const loopMarket = (over: Partial<any> = {}) => ({
  morphoMarketId: LOOP_ID,
  marketParams: {},
  correlated: true,
  liqLtv: "91.50",
  borrowApy: "4.00",
  borrowIncentiveApy: "1.00",
  borrowIncentiveBreakdown: [{ symbol: "DOLA", apy: "1.00" }],
  borrowIncentiveHistory: [{ ts: NOW - 365 * DAY_MS, apr: 1 }],
  collateralIncentiveApy: "0.00",
  collateralIncentiveBreakdown: [],
  collateralIncentiveHistory: [],
  collateralTokenValueInLoanToken: BigNumber("1.05"),
  collateralToken: { address: "0xc0", symbol: "syrupUSDC", decimals: 6, apy: "8.00", valueInUsd: BigNumber("1.05"), isPt: false, info: { project: "Maple", exitSlippage100k: 0.1, exitSlippage500k: 0.2, exitSlippage1M: 0.4, exitSlippage5M: 2, exitSlippage10M: 3 } },
  loanToken: { address: "0x10", symbol: "USDC", decimals: 6, valueInUsd: BigNumber(1) },
  ...over,
});

// A perp: collateral now $2.20 (entered at $2.00), no yield, 5% borrow, no incentives.
const perpMarket = () =>
  loopMarket({
    morphoMarketId: PERP_ID,
    correlated: false,
    borrowApy: "5.00",
    borrowIncentiveApy: "0.00",
    borrowIncentiveBreakdown: [],
    borrowIncentiveHistory: [],
    collateralTokenValueInLoanToken: BigNumber("2.2"),
    collateralToken: { address: "0xc1", symbol: "PONS", decimals: 18, apy: "0.00", valueInUsd: BigNumber("2.2"), isPt: false, info: { project: "Pons" } },
  });

interface ChainPos {
  open: boolean;
  marketId: string;
  deposited: bigint;
  returned: bigint;
  collateral: bigint;
  debt: bigint;
}

function mockChain(positions: ChainPos[]) {
  vi.mocked(getClient).mockReturnValue({
    readContract: vi.fn().mockResolvedValue(
      positions.map((p) => ({ open: p.open, marketId: p.marketId, userProxy: PROXY, amountDepositedInLoanToken: p.deposited, amountReturnedInLoanToken: p.returned })),
    ),
    multicall: vi
      .fn()
      .mockResolvedValueOnce(positions.map((p, i) => ({ borrowShares: BigInt(i + 1), collateral: p.collateral })))
      .mockResolvedValueOnce(positions.map((p) => p.debt)),
  } as any);
}

const row = (over: Partial<PortfolioDbRow> & { marketId: string; index: number }): PortfolioDbRow => ({
  positionId: `${USER}-${over.marketId}-${over.index}`,
  user: USER,
  chainId: CHAIN,
  open: true,
  amountDepositedInUsd: 1000,
  desiredLtv: 80,
  createdAt: new Date(NOW - 365 * DAY_MS).toISOString(),
  updatedAt: new Date(NOW - 365 * DAY_MS).toISOString(),
  ...over,
});

beforeEach(() => {
  vi.mocked(getClient).mockReset();
  vi.mocked(composeSnapshot).mockReset();
  vi.mocked(getJson).mockReset().mockResolvedValue([]);
  vi.mocked(discoverChainUsers).mockReset().mockResolvedValue([]);
  vi.mocked(composeSnapshot).mockReturnValue({ markets: [{ market: loopMarket() }, { market: perpMarket() }] } as any);
});

describe("open correlated loop (OpenPositionView)", () => {
  // 5,000 collateral (5,250 in loan units), 4,000 debt, 1,000 basis; the row recorded 1,000 USD and
  // a 7.5% base APY at open, one year ago.
  const chain: ChainPos = { open: true, marketId: LOOP_ID, deposited: 1_000_000_000n, returned: 0n, collateral: 5_000_000_000n, debt: 4_000_000_000n };

  it("derives every card figure as the app does", async () => {
    mockChain([chain]);
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [row({ marketId: LOOP_ID, index: 0, atTokenApy: 7.5 })], nowMs: NOW });

    expect(w.positions).toHaveLength(1);
    expect(w.closed).toHaveLength(0);
    expect(w.unresolved).toHaveLength(0);
    const p = w.positions[0];
    expect(p.status).toBe("open");
    expect(p.dbDrift).toEqual([]);
    expect(p.onchain.ltvPct).toBe("76.19"); // 4000 / 5250
    expect(p.leverage).toBe("4.2"); // 100 / (100 − 76.19)
    // (7.5 base + 0 collateral incentive) × 4.2 − (4 − 1 net borrow) × 3.2 = 31.5 − 9.6
    expect(p.leverageApyPct).toBe("21.90");
    expect(p.apyBadge).toBe("21.90% APY");
    expect(p.market.project).toBe("Maple");
    expect(p.market.exitLiquidity.tier).toBe("good");
    expect(p.market.exitLiquidity.exceedsCleanExitSize).toBe(false);
    expect(p.market.links.app).toBe(`${env.APP_URL}/1/strategies/${LOOP_ID}/syrupUSDC-USDC?profile=yield`);
    expect(p.market.links.externalKind).toBe("morpho");

    // yield: equity 1,250 − basis 1,000 = 250 on chain, + 1% of the 4,000 borrowed for a year = 40
    close(p.yield.baseUsd, 250);
    close(p.yield.incentiveUsd, 40);
    close(p.yield.totalUsd, 290);
    close(p.yield.roePct, 29);
    expect(p.yield.incentiveSymbols).toBe("DOLA");

    const v = p.view.open!;
    expect(v.amountDeposited).toEqual({ loanToken: "1000", usd: "1000", source: "db" });
    expect(v.totalSupplied.label).toBe("Total Supplied");
    expect(v.totalSupplied.collateral).toBe("5000");
    close(v.totalSupplied.usd, 5250);
    expect(v.totalSupplied.leverage).toBe("4.2");
    expect(v.borrowed).toEqual({ loanToken: "4000", usd: "4000" });
    // Projected: 21.90% × 1,250 equity × 365/365 = 273.75, plus the 290 already earned
    expect(v.projectedYield!.days).toBe(env.PORTFOLIO_DEFAULT_DAYS);
    close(v.projectedYield!.loanToken, 273.75 + 290);
    close(v.projectedYield!.usd, 273.75 + 290);
    close(v.projectedYield!.yieldGenerated.loanToken, 290);
    expect(v.profit).toBeNull();
    expect(v.ltv).toEqual({ pct: "76.19", liqPct: "91.50" });
    expect(v.price!.current).toBe("1.05");
    expect(v.price!.breakEven).toBeNull();
    close(v.price!.liquidation, (76.19 / 91.5) * 1.05);
    expect(v.price!.dropToLiquidationPct).toBe("16.7");
  });

  it("falls back to the on-chain basis and flags the missing row", async () => {
    mockChain([chain]);
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [], nowMs: NOW });
    const p = w.positions[0];
    expect(p.dbDrift).toEqual(["no_db_row"]);
    expect(p.db).toBeNull();
    expect(p.openedAt).toBeNull();
    expect(p.view.open!.amountDeposited).toEqual({ loanToken: "1000", usd: "1000", source: "chain" });
    // No open date → no incentive accrual (the app can't size it either).
    expect(p.yield.incentiveUsd).toBe("0");
    // Live collateral APY is used when the row's snapshot is absent: (8 + 0) × 4.2 − 3 × 3.2 = 24.0
    expect(p.leverageApyPct).toBe("24.00");
    expect(w.header).toEqual({ totalDepositedUsd: "1000", openCount: 1 });
  });
});

describe("open perp (RoeView with / without leverage)", () => {
  // 1,000 PONS worth 2,200 loan tokens, 1,200 debt, 800 basis; entered at $2.00, now $2.20.
  const chain: ChainPos = { open: true, marketId: PERP_ID, deposited: 800_000_000n, returned: 0n, collateral: 1_000n * 10n ** 18n, debt: 1_200_000_000n };

  it("shows the leveraged profit against the unleveraged price move and the break-even", async () => {
    mockChain([chain]);
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [row({ marketId: PERP_ID, index: 0, amountDepositedInUsd: 800, entryPriceUsd: 2 })], nowMs: NOW });
    const p = w.positions[0];
    expect(p.onchain.ltvPct).toBe("54.55");
    expect(p.apyBadge).toBe("6.00% Borrow APY"); // sign-flipped (0 × 2.2 − 5 × 1.2) as the app prints it
    const v = p.view.open!;
    expect(v.totalSupplied.label).toBe("Exposure");
    expect(v.projectedYield).toBeNull();
    close(v.profit!.withLeverage.usd, 200); // 2200 − 1200 − 800
    close(v.profit!.withLeverage.pct, 25); // / 800
    close(v.profit!.withoutLeverage!.usd, 80); // 800 × 10%
    close(v.profit!.withoutLeverage!.pct, 10);
    expect(v.price!.breakEven).toBe("2"); // (1200 + 800) / 1000
  });

  it("drops the unleveraged line when no entry price was recorded", async () => {
    mockChain([chain]);
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [row({ marketId: PERP_ID, index: 0, amountDepositedInUsd: 800 })], nowMs: NOW });
    expect(w.positions[0].view.open!.profit!.withoutLeverage).toBeNull();
  });
});

describe("closed loop (ClosedOrMaturedView)", () => {
  // Closed at a loss: the contract keeps deposited − returned = 6.75 as the residual and 193.25 as
  // returned; the row recorded 200 in / 195 back, opened 30 days ago, closed 10 days ago.
  const chain: ChainPos = { open: false, marketId: LOOP_ID, deposited: 6_750_000n, returned: 193_250_000n, collateral: 0n, debt: 0n };
  const closedRow = () =>
    row({
      marketId: LOOP_ID,
      index: 0,
      open: false,
      amountDepositedInUsd: 200,
      amountReturnedInUsd: 195,
      createdAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
    });

  it("recovers the basis, sizes the incentive from the recorded deposit and LTV, and adds it to the return", async () => {
    mockChain([chain]);
    vi.mocked(composeSnapshot).mockReturnValue({
      markets: [{ market: loopMarket({ borrowIncentiveHistory: [{ ts: NOW - 30 * DAY_MS, apr: 3.65 }] }) }],
    } as any);
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [closedRow()], nowMs: NOW });
    expect(w.positions).toHaveLength(0);
    expect(w.closed).toHaveLength(1);
    const p = w.closed[0];
    expect(p.status).toBe("closed");
    expect(p.dbDrift).toEqual([]);
    expect(p.onchain.amountDepositedInLoanToken).toBe("200"); // residual + returned
    expect(p.db!.returnedUsd).toBe(195);
    expect(p.db!.yieldUsd).toBe(-5);
    // Incentive over the 20 days it was open: collateral = 200 / (1 − 0.8) = 1,000, borrowed 800,
    // at 3.65% for 20/365 of a year = 1.6
    close(p.yield.incentiveUsd, 1.6);
    close(p.yield.totalUsd, -3.4);
    const v = p.view.closed!;
    expect(v.amountDeposited).toEqual({ loanToken: "200", usd: "200", source: "db" });
    close(v.amountReturned.usd, 196.6); // 195 + the 1.6 still to claim
    close(v.amountReturned.claimableIncentiveUsd, 1.6);
    expect(v.yieldGenerated!.usd).toBe("0"); // floored at 0 on the card
    expect(v.profit).toBeNull();
    expect(w.header).toEqual({ totalDepositedUsd: "0", openCount: 0 });
  });

  it("flags a row the chain has moved past (close registration lost)", async () => {
    mockChain([chain]);
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [row({ marketId: LOOP_ID, index: 0, amountDepositedInUsd: 200 })], nowMs: NOW });
    const p = w.closed[0];
    expect(p.dbDrift).toEqual(["db_open_chain_closed"]);
    // No recorded return → the on-chain figures, resolved the same way on both sides of the card.
    expect(p.view.closed!.amountDeposited.source).toBe("db");
    close(p.view.closed!.amountReturned.usd, 193.25);
  });
});

describe("liquidated / unresolved / header", () => {
  it("renders a liquidated position through the open row without price or leverage, in the closed list", async () => {
    mockChain([{ open: true, marketId: LOOP_ID, deposited: 1_000_000_000n, returned: 0n, collateral: 0n, debt: 0n }]);
    const w = await buildWalletPortfolio(CHAIN, USER, { rows: [row({ marketId: LOOP_ID, index: 0 })], nowMs: NOW });
    expect(w.positions).toHaveLength(0);
    const p = w.closed[0];
    expect(p.status).toBe("liquidated");
    expect(p.yield.incentiveUsd).toBe("0"); // hard-zeroed for liquidations
    expect(p.view.open!.price).toBeNull();
    expect(p.view.open!.totalSupplied.leverage).toBeNull();
    expect(p.view.open!.projectedYield).toBeNull();
    expect(w.header.openCount).toBe(0);
  });

  it("lists rows with nothing behind them on chain and sums the header over open positions only", async () => {
    mockChain([
      { open: true, marketId: LOOP_ID, deposited: 1_000_000_000n, returned: 0n, collateral: 5_000_000_000n, debt: 4_000_000_000n },
      { open: true, marketId: PERP_ID, deposited: 800_000_000n, returned: 0n, collateral: 1_000n * 10n ** 18n, debt: 1_200_000_000n },
    ]);
    const rows = [
      row({ marketId: LOOP_ID, index: 0 }),
      row({ marketId: PERP_ID, index: 1, amountDepositedInUsd: 800 }),
      row({ marketId: LOOP_ID, index: 7, amountDepositedInUsd: 50 }), // index the chain never reached
      row({ marketId: "0x9999999999999999999999999999999999999999999999999999999999999999", index: 0, amountDepositedInUsd: 60 }),
    ];
    const w = await buildWalletPortfolio(CHAIN, USER, { rows, nowMs: NOW });
    expect(w.positions.map((p) => p.id)).toEqual([1, 0]); // newest first
    expect(w.header).toEqual({ totalDepositedUsd: "1800", openCount: 2 });
    expect(w.unresolved.map((u) => u.reason)).toEqual(["no_chain_position", "market_not_configured"]);
  });
});

describe("getAllPortfolios", () => {
  it("unions chain-discovered and dashboard-known wallets, then serves the cache within the window", async () => {
    mockChain([{ open: true, marketId: LOOP_ID, deposited: 1_000_000_000n, returned: 0n, collateral: 5_000_000_000n, debt: 4_000_000_000n }]);
    vi.mocked(discoverChainUsers).mockResolvedValue([USER]);
    vi.mocked(getJson).mockResolvedValue([row({ marketId: LOOP_ID, index: 0 })]);

    const first = await getAllPortfolios(CHAIN);
    expect(first.users.map((u) => u.address)).toEqual([USER]);
    expect(first.counts).toEqual({ users: 1, open: 1, equity: 0, closed: 0, unresolved: 0, drift: 0 });
    expect(first.stale).toBe(false);
    expect(first.degraded).toBe(false);
    expect(rawStore.isPrimed(KEYS.portfolio(CHAIN))).toBe(true);

    const client = vi.mocked(getClient).mock.results[0]!.value;
    const reads = client.readContract.mock.calls.length;
    const second = await getAllPortfolios(CHAIN);
    expect(second.computedAt).toBe(first.computedAt);
    expect(client.readContract.mock.calls.length).toBe(reads); // no recompute inside the window
  });
});

describe("accruedIncentiveUsd", () => {
  it("integrates the step-function history and falls back to the spot APR only with no history", () => {
    const open = NOW - 100 * DAY_MS;
    // 2% for the first 50 days, 4% after: 1000 × (0.02 × 50 + 0.04 × 50) / 365
    close(accruedIncentiveUsd([{ ts: open, apr: 2 }, { ts: open + 50 * DAY_MS, apr: 4 }], "9", 1000, open, NOW), (1000 * (1 + 2)) / 365);
    close(accruedIncentiveUsd([], "3.65", 1000, open, NOW), 10);
    expect(accruedIncentiveUsd([], "0", 1000, open, NOW)).toBe(0);
    expect(accruedIncentiveUsd([{ ts: open, apr: 2 }], "2", 1000, 0, NOW)).toBe(0);
  });
});
