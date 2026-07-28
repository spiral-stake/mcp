// Locks the safe-LTV ceiling on the two manage actions that raise LTV from an absolute amount
// rather than a target LTV: remove_collateral and borrow. Both previously built a tx with NO LTV
// ceiling at all — the contract only reverts above maxLtv (= safeLtv + 0.75), so an agent could
// land a position a fraction of a percent from liquidation on a path the app's manage cards
// hard-cap at safeLtv. A regression here is a direct liquidation-risk issue.
import { vi, describe, it, expect } from "vitest";
import BigNumber from "bignumber.js";

vi.mock("../../src/core/freshness.ts", () => ({ assertMarketDataFresh: vi.fn() }));
vi.mock("../../src/execution/positions.ts", () => ({ readManagePosition: vi.fn() }));
vi.mock("../../src/data/markets.ts", () => ({
  readAddresses: () => ({
    flashLeverageAddress: "0x4444444444444444444444444444444444444444",
    flashLeverageRouterAddress: "0x5555555555555555555555555555555555555555",
  }),
  readToken: () => undefined,
}));

import { readManagePosition } from "../../src/execution/positions.ts";
import { buildManageTx } from "../../src/execution/buildManage.ts";

const USER = "0x2222222222222222222222222222222222222222";

// 100 collateral @ 1.0 loan-token each, 80 debt => LTV 80%. safeLtv 85%, liq 86%.
// remove_collateral headroom: 100 - 80/0.85 = 5.882352... collateral
// borrow headroom:            0.85*100 - 80  = 5 loan token
const position = (over: Partial<any> = {}) => ({
  open: true,
  collateralRaw: 100n * 10n ** 18n,
  borrowShares: 0n,
  amountLeveragedCollateral: BigNumber(100),
  amountLoan: BigNumber(80),
  market: {
    morphoMarketId: "0xabc",
    safeLtv: "85.00",
    liqLtv: "86.00",
    collateralTokenValueInLoanToken: BigNumber(1),
    collateralToken: { address: "0x6666666666666666666666666666666666666666", symbol: "strUSD", decimals: 18, isPt: false },
    loanToken: { address: "0x7777777777777777777777777777777777777777", symbol: "USDC", decimals: 6 },
  },
  ...over,
});

const build = (action: string, amount: string, over?: Partial<any>) => {
  vi.mocked(readManagePosition).mockResolvedValue(position(over) as any);
  return buildManageTx({ chainId: 1, userAddress: USER, id: 0, action: action as any, amount });
};

describe("buildManageTx safe-LTV ceiling", () => {
  describe("remove_collateral", () => {
    it("allows a withdrawal that stays at or below safeLtv", async () => {
      await expect(build("remove_collateral", "5")).resolves.toMatchObject({ contractFn: "withdrawCollateral" });
    });

    it("allows exactly the headroom (lands on safeLtv)", async () => {
      await expect(build("remove_collateral", "5.882352")).resolves.toMatchObject({ contractFn: "withdrawCollateral" });
    });

    it("rejects a withdrawal that pushes LTV above safeLtv, and reports the safe maximum", async () => {
      await expect(build("remove_collateral", "6")).rejects.toThrow(/85\.11%.*safe LTV of 85\.00%.*5\.882352 strUSD/s);
    });

    it("rejects withdrawing the entire collateral while debt is outstanding (infinite LTV)", async () => {
      // Guards the calcLtv non-finite path: it reports "0.00" for a zero-collateral position,
      // which would otherwise read as the SAFEST possible request.
      await expect(build("remove_collateral", "100")).rejects.toThrow(/infinite/);
      await expect(build("remove_collateral", "150")).rejects.toThrow(/infinite/);
    });

    it("allows withdrawing everything once the debt is cleared", async () => {
      await expect(
        build("remove_collateral", "100", { amountLoan: BigNumber(0) }),
      ).resolves.toMatchObject({ contractFn: "withdrawCollateral" });
    });
  });

  describe("borrow", () => {
    it("allows a borrow that stays at or below safeLtv", async () => {
      await expect(build("borrow", "4")).resolves.toMatchObject({ contractFn: "borrow" });
    });

    it("allows exactly the headroom (lands on safeLtv)", async () => {
      await expect(build("borrow", "5")).resolves.toMatchObject({ contractFn: "borrow" });
    });

    it("rejects a borrow that pushes LTV above safeLtv, and reports the safe maximum", async () => {
      await expect(build("borrow", "6")).rejects.toThrow(/86\.00%.*safe LTV of 85\.00%.*5\.000000 USDC/s);
    });

    it("rejects a borrow that would exceed even the liquidation LTV", async () => {
      await expect(build("borrow", "50")).rejects.toThrow(/safe LTV/);
    });
  });
});
