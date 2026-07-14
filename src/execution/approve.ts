// ERC-20 approval calls — ported from v2-client ERC20.approveCalls. Faithful to the app:
//  - non-USDT: always emit a single approve(spender, amount) (no allowance check — matches the app).
//  - USDT: allowance-aware, with the reset-to-0 dance (USDT reverts on a non-zero→non-zero approve).
// The app read the current allowance via wagmi getAccount(); here the userAddress is passed in and
// the allowance is read via viem.
import { encodeFunctionData } from "viem";
import erc20Json from "../abi/IERC20.sol/IERC20.json" with { type: "json" };
import { parseUnits } from "../core/formatUnits.ts";
import { getClient } from "../sources/onchain.ts";

const ERC20_ABI = (erc20Json as { abi: readonly unknown[] }).abi;

export interface Call {
  to: string;
  data: string;
  value?: string;
}

export async function buildApproveCalls(
  chainId: number,
  userAddress: string,
  token: { address: string; decimals: number; symbol: string },
  spender: string,
  amount: string, // human units
): Promise<Call[]> {
  const parsedAmount = parseUnits(amount, token.decimals);
  const approve = (spenderAddr: string, value: bigint): Call => ({
    to: token.address,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spenderAddr, value] }),
  });

  if (token.symbol === "USDT") {
    const current = (await getClient(chainId).readContract({
      abi: ERC20_ABI,
      address: token.address as `0x${string}`,
      functionName: "allowance",
      args: [userAddress, spender],
    })) as bigint;
    if (current >= parsedAmount) return [];
    if (current > 0n) return [approve(spender, 0n), approve(spender, parsedAmount)];
  }
  return [approve(spender, parsedAmount)];
}
