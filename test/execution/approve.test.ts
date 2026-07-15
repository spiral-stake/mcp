// Locks ERC-20 approval scoping: the built approval must authorise the EXACT amount to the EXACT
// spender that pulls the funds (never infinite), and USDT must get the non-zero -> 0 -> amount reset
// (USDT reverts a non-zero->non-zero approve). A regression here is a direct fund-safety issue.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/sources/onchain.ts", () => ({ getClient: vi.fn() }));

import { decodeFunctionData, parseUnits } from "viem";
import erc20 from "../../src/abi/IERC20.sol/IERC20.json" with { type: "json" };
import { getClient } from "../../src/sources/onchain.ts";
import { buildApproveCalls } from "../../src/execution/approve.ts";

const ABI = (erc20 as any).abi;
const SPENDER = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const decode = (data: string) => decodeFunctionData({ abi: ABI, data: data as `0x${string}` });
const mockAllowance = (v: bigint) => vi.mocked(getClient).mockReturnValue({ readContract: vi.fn().mockResolvedValue(v) } as any);

beforeEach(() => vi.mocked(getClient).mockReset());

describe("buildApproveCalls", () => {
  it("non-USDT: a single approve for the exact amount to the exact spender (no allowance read)", async () => {
    const calls = await buildApproveCalls(1, USER, { address: TOKEN, decimals: 18, symbol: "sUSDS" }, SPENDER, "1000");
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(TOKEN);
    const d = decode(calls[0].data);
    expect(d.functionName).toBe("approve");
    expect(d.args[0]).toBe(SPENDER);
    expect(d.args[1]).toBe(parseUnits("1000", 18)); // exact, not MaxUint256
    expect(getClient).not.toHaveBeenCalled();
  });

  it("USDT with zero allowance: a single approve", async () => {
    mockAllowance(0n);
    const calls = await buildApproveCalls(1, USER, { address: TOKEN, decimals: 6, symbol: "USDT" }, SPENDER, "1000");
    expect(calls).toHaveLength(1);
    expect(decode(calls[0].data).args[1]).toBe(parseUnits("1000", 6));
  });

  it("USDT already sufficiently approved: no calls", async () => {
    mockAllowance(parseUnits("5000", 6));
    const calls = await buildApproveCalls(1, USER, { address: TOKEN, decimals: 6, symbol: "USDT" }, SPENDER, "1000");
    expect(calls).toHaveLength(0);
  });

  it("USDT with a non-zero, insufficient allowance: reset to 0 then approve", async () => {
    mockAllowance(parseUnits("10", 6));
    const calls = await buildApproveCalls(1, USER, { address: TOKEN, decimals: 6, symbol: "USDT" }, SPENDER, "1000");
    expect(calls).toHaveLength(2);
    expect(decode(calls[0].data).args[1]).toBe(0n); // reset first
    expect(decode(calls[1].data).args[1]).toBe(parseUnits("1000", 6));
    // both target the exact spender
    expect(decode(calls[0].data).args[0]).toBe(SPENDER);
    expect(decode(calls[1].data).args[0]).toBe(SPENDER);
  });
});
