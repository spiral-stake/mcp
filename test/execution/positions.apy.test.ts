// Locks cross-surface parity for a live position's APY: get_positions must size
// currentLeverageApyPct from the same effective collateral yield (base APY + collateral-side Merkl
// incentive) as the /v1/strategies ladder and the simulate preview. It previously used the bare
// base APY, so a 9.77x syrupUSDG loop on Robinhood reported 13.45% against a ~38% ladder at the
// same LTV, and USDe (all-incentive yield) positions read deeply negative.
import { vi, describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";

vi.mock("../../src/sources/onchain.ts", () => ({ getClient: vi.fn() }));
vi.mock("../../src/core/compose.ts", () => ({ composeSnapshot: vi.fn() }));
vi.mock("../../src/data/markets.ts", () => ({
  readAddresses: () => ({ flashLeverageAddress: "0x4444444444444444444444444444444444444444" }),
}));

import { getClient } from "../../src/sources/onchain.ts";
import { composeSnapshot } from "../../src/core/compose.ts";
import { calcLeverageApy } from "../../src/core/leverage.ts";
import { getUserPositions } from "../../src/execution/positions.ts";

const MARKET_ID = "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7";
const USER = "0x2222222222222222222222222222222222222222";

// syrupUSDG/USDG on 4663 as composed on 2026-09-24: 5.00% base + 2.50% USDG collateral incentive,
// 4.04% borrow, no borrow incentive. Collateral priced 1:1 in the loan token for a round LTV.
const market = (over: Partial<any> = {}) => ({
  morphoMarketId: MARKET_ID,
  marketParams: {},
  correlated: true,
  liqLtv: "91.50",
  borrowApy: "4.04",
  borrowIncentiveApy: "0.00",
  collateralIncentiveApy: "2.50",
  collateralTokenValueInLoanToken: BigNumber(1),
  collateralToken: { symbol: "syrupUSDG", decimals: 6, apy: "5.00", valueInUsd: BigNumber(1), info: {} },
  loanToken: { symbol: "USDG", decimals: 6, valueInUsd: BigNumber(1) },
  ...over,
});

// One open position: 17,709.232414 collateral, 16,089.043245 debt => LTV 90.85%.
const COLLATERAL = 17_709_232_414n;
const DEBT = 16_089_043_245n;

function mockChain() {
  vi.mocked(getClient).mockReturnValue({
    readContract: vi.fn().mockResolvedValue([
      { open: true, marketId: MARKET_ID, userProxy: "0x3333333333333333333333333333333333333333", amountDepositedInLoanToken: 0n, amountReturnedInLoanToken: 0n },
    ]),
    multicall: vi.fn().mockResolvedValueOnce([{ borrowShares: 1n, collateral: COLLATERAL }]).mockResolvedValueOnce([DEBT]),
  } as any);
}

beforeEach(() => {
  vi.mocked(getClient).mockReset();
  vi.mocked(composeSnapshot).mockReset();
});

describe("getUserPositions currentLeverageApyPct", () => {
  it("includes the collateral-side incentive, matching the ladder's APY at the same LTV", async () => {
    mockChain();
    vi.mocked(composeSnapshot).mockReturnValue({ markets: [{ market: market() }] } as any);

    const [pos] = await getUserPositions(4663, USER);

    expect(pos.ltvPct).toBe("90.85");
    // Same formula, same inputs as strategy.ts' honestLeverageApy: (base + incentive) vs net borrow.
    const expected = calcLeverageApy(true, "7.50", "4.04", "90.85");
    expect(pos.currentLeverageApyPct).toBe(expected);
    // And explicitly NOT the incentive-less figure it used to report.
    expect(pos.currentLeverageApyPct).not.toBe(calcLeverageApy(true, "5.00", "4.04", "90.85"));
    expect(Number(pos.currentLeverageApyPct)).toBeGreaterThan(38);
  });

  it("is unchanged on a market with no collateral incentive", async () => {
    mockChain();
    vi.mocked(composeSnapshot).mockReturnValue({ markets: [{ market: market({ collateralIncentiveApy: "0.00" }) }] } as any);

    const [pos] = await getUserPositions(4663, USER);

    expect(pos.currentLeverageApyPct).toBe(calcLeverageApy(true, "5.00", "4.04", "90.85"));
  });

  it("turns an all-incentive yield (USDe: 0% base + 4.02% incentive) positive instead of deeply negative", async () => {
    mockChain();
    vi.mocked(composeSnapshot).mockReturnValue({
      markets: [{ market: market({ collateralIncentiveApy: "4.02", borrowApy: "4.48", collateralToken: { symbol: "USDe", decimals: 6, apy: "0.00", valueInUsd: BigNumber(1), info: {} } }) }],
    } as any);

    const [pos] = await getUserPositions(4663, USER);

    expect(pos.currentLeverageApyPct).toBe(calcLeverageApy(true, "4.02", "4.48", "90.85"));
    expect(Number(calcLeverageApy(true, "0.00", "4.48", "90.85"))).toBeLessThan(-40);
  });
});
