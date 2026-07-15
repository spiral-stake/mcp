// Guards the ABI wiring the builders depend on: every contract call the open/manage builders emit
// must encode and decode cleanly with the right function name and arity. If a synced ABI drifts or a
// builder references a renamed method, encodeFunctionData throws — this catches it in CI, not in a
// user's wallet. (Full path-selection/value behaviour is covered by the fork integration test.)
import { describe, it, expect } from "vitest";
import { encodeFunctionData, decodeFunctionData } from "viem";
import flr from "../../src/abi/FlashLeverage.sol/FlashLeverage.json" with { type: "json" };
import router from "../../src/abi/FlashLeverageRouter.sol/FlashLeverageRouter.json" with { type: "json" };

const FLR = (flr as any).abi;
const ROUTER = (router as any).abi;
const swapData = { extRouter: "0x0000000000000000000000000000000000000001", extCalldata: "0xdead" };
const mid = "0x3274643db77a064abd3bc851de77556a4ad2e2f502f4f0c80845fa8f909ecf0b";
const U = "0x1111111111111111111111111111111111111111";
const params = { marketId: mid, amountCollateral: 1000n, amountFlashLoan: 500n, swapData, minTokenOut: 100n };
const mp = {
  loanToken: U, collateralToken: U, oracle: U, irm: U, lltv: 945000000000000000n,
};
const reallocate = [{ vault: U, fee: 0n, withdrawals: [{ marketParams: mp, amount: 1n }], supplyMarketParams: mp }];

// [abi, functionName, args] for every call the builders produce.
const calls: [readonly unknown[], string, unknown[]][] = [
  // open
  [FLR, "leverage", [U, params]],
  [ROUTER, "swapAndLeverage", [U, 1000n, swapData, 100n, params]],
  [ROUTER, "reallocateAndLeverage", [reallocate, params]],
  [ROUTER, "reallocateSwapAndLeverage", [reallocate, U, 1000n, swapData, 100n, params]],
  // manage + close
  [FLR, "deleverage", [3n, 0n, swapData, 100n]],
  [FLR, "increaseLeverage", [3n, 500n, swapData, 100n]],
  [FLR, "supplyCollateral", [U, 3n, 1000n]],
  [ROUTER, "swapAndSupplyCollateral", [U, 3n, mid, U, 1000n, swapData, 100n]],
  [FLR, "repay", [U, 3n, 1000n, 2n ** 256n - 1n]],
  [ROUTER, "swapAndRepay", [U, 3n, mid, U, 1000n, swapData, 100n, 2n ** 256n - 1n]],
  [FLR, "withdrawCollateral", [3n, 1000n]],
  [FLR, "borrow", [3n, 1000n]],
];

describe("execution calldata conformance", () => {
  it.each(calls)("%# %s encodes + decodes cleanly", (abi, fn, args) => {
    const data = encodeFunctionData({ abi: abi as any, functionName: fn as any, args: args as any });
    const back = decodeFunctionData({ abi: abi as any, data });
    expect(back.functionName).toBe(fn);
    expect(back.args).toHaveLength(args.length);
  });
});
