// Locks the fail-CLOSED fee receiver: a fee-bearing swap is refused unless FEE_RECEIVER is the treasury
// SAFE, and the env schema refuses to boot on a missing, malformed or foreign receiver. Before this, an
// unset or mistyped receiver built the swap with NO fee — protocol revenue silently dropped to zero.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const SAFE = "0x9ced716f16651b69D5167C82003690621e8F90b9";
// vi.mock factories are hoisted above module scope, so the mutable env must be hoisted with them.
const { envMock } = vi.hoisted(() => ({
  envMock: { FEE_RECEIVER: "0x9ced716f16651b69D5167C82003690621e8F90b9" } as { FEE_RECEIVER?: string },
}));

vi.mock("../../src/config/env.ts", () => ({ env: envMock }));
vi.mock("../../src/sources/http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sources/http.ts")>()),
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

import { getJson, postJson } from "../../src/sources/http.ts";
import { getSwapData, requireFeeReceiver } from "../../src/execution/swap.ts";
import { TREASURY_SAFE, isTreasurySafe } from "../../src/config/treasury.ts";

const KYBER_ROUTES = { data: { routeSummary: {}, tokenIn: "x" } };
const KYBER_BUILT = { data: { routerAddress: "0xRouter", data: "0xcalldata", amountOut: "906" } };

beforeEach(() => {
  envMock.FEE_RECEIVER = SAFE;
  vi.mocked(getJson).mockReset().mockResolvedValue(KYBER_ROUTES);
  vi.mocked(postJson).mockReset().mockResolvedValue(KYBER_BUILT);
});
afterEach(() => {
  envMock.FEE_RECEIVER = SAFE;
});

describe("treasury SAFE constant", () => {
  it("is the canonical SAFE and matches case-insensitively", () => {
    expect(TREASURY_SAFE).toBe(SAFE);
    expect(isTreasurySafe(SAFE.toLowerCase())).toBe(true);
    expect(isTreasurySafe("0x0000000000000000000000000000000000000001")).toBe(false);
    expect(isTreasurySafe(undefined)).toBe(false);
  });
});

describe("requireFeeReceiver", () => {
  it("returns the SAFE when configured", () => {
    expect(requireFeeReceiver()).toBe(SAFE);
  });
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["malformed", "0x9ced"],
    ["another wallet", "0x000000000000000000000000000000000000dEaD"],
  ])("throws when FEE_RECEIVER is %s", (_label, value) => {
    envMock.FEE_RECEIVER = value;
    expect(() => requireFeeReceiver()).toThrow(/fee receiver misconfigured/i);
  });
});

describe("getSwapData — fail-closed", () => {
  it("refuses a fee-bearing KyberSwap swap without a valid receiver (no upstream call is made)", async () => {
    envMock.FEE_RECEIVER = undefined;
    await expect(getSwapData(1, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005)).rejects.toThrow(/fee receiver misconfigured/i);
    expect(getJson).not.toHaveBeenCalled();
  });
  it("refuses a fee-bearing Pendle swap without a valid receiver", async () => {
    envMock.FEE_RECEIVER = "0x000000000000000000000000000000000000dEaD";
    await expect(getSwapData(1, true, "0xRecv", "0xIn", "0xPT", 1000n, 0.005)).rejects.toThrow(/fee receiver misconfigured/i);
    expect(postJson).not.toHaveBeenCalled();
  });
  it("still builds a feeBps=0 swap (close / increase_leverage) without any receiver", async () => {
    envMock.FEE_RECEIVER = undefined;
    const res = await getSwapData(1, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0);
    expect(res.swapData.extCalldata).toBe("0xcalldata");
    expect(vi.mocked(getJson).mock.calls[0][0]).not.toContain("feeReceiver");
  });
  it("carries the SAFE and the rate when configured", async () => {
    await getSwapData(1, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 25);
    const url = vi.mocked(getJson).mock.calls[0][0];
    expect(url).toContain(`feeReceiver=${SAFE}`);
    expect(url).toContain("feeAmount=25");
  });
});
