// Public-allocator reallocation — ported from v2-client utils/publicAllocator.ts::buildReallocateParams.
// When the desired flash loan exceeds the market's direct liquidity, the router pulls liquidity from
// the vault's other markets first. This greedily selects source markets (largest first), groups by
// vault, resolves each source market's params on-chain (Morpho.idToMarketParams), and sums per-vault
// fees (which must be added to msg.value). Logic mirrors the app exactly.
import type { Abi } from "viem";
import morphoJson from "../abi/IMorpho.sol/IMorpho.json" with { type: "json" };
import { getClient } from "../sources/onchain.ts";
import { readAddresses } from "../data/markets.ts";
import type { Market, MarketParams, ReallocateParams } from "../types/index.ts";

const MORPHO_ABI = (morphoJson as { abi: Abi }).abi;

export interface BuildReallocateResult {
  params: ReallocateParams[];
  /** Sum of per-vault fees (wei). Must be included in msg.value. */
  totalFee: bigint;
}

export async function buildReallocateParams(
  chainId: number,
  market: Market,
  amountFlashLoan: bigint,
): Promise<BuildReallocateResult> {
  const morphoAddress = readAddresses(chainId).morphoAddress as `0x${string}`;

  // 1. Sort source markets by available assets (descending) to minimise reallocations.
  const sorted = [...market.paSharedLiquidity].sort((a, b) =>
    Number(BigInt(b.assets) - BigInt(a.assets)),
  );

  // 2. Greedily draw from markets until amountFlashLoan is covered.
  interface WithdrawalEntry {
    marketId: string;
    amount: bigint;
  }
  const vaultMap = new Map<string, WithdrawalEntry[]>();
  const vaultFeeMap = new Map<string, bigint>(); // fee is per-vault, recorded once
  let remaining = amountFlashLoan;

  for (const entry of sorted) {
    if (remaining <= 0n) break;
    const available = BigInt(entry.assets);
    if (available <= 0n) continue;

    const withdrawAmount = available < remaining ? available : remaining;
    const vaultAddress = entry.vault.address;

    if (!vaultFeeMap.has(vaultAddress)) {
      vaultFeeMap.set(vaultAddress, BigInt(entry.vault.publicAllocatorConfig?.fee ?? 0));
    }
    const withdrawal: WithdrawalEntry = { marketId: entry.withdrawMarket.marketId, amount: withdrawAmount };
    const existing = vaultMap.get(vaultAddress);
    if (existing) existing.push(withdrawal);
    else vaultMap.set(vaultAddress, [withdrawal]);

    remaining -= withdrawAmount;
  }

  // 3. Resolve every source market's params on-chain (batched via multicall), then build params —
  //    withdrawals sorted by market id ascending, as the contract requires.
  const params: ReallocateParams[] = [];
  let totalFee = 0n;

  for (const [vaultAddress, withdrawals] of vaultMap) {
    const marketParamsList = (await getClient(chainId).multicall({
      contracts: withdrawals.map((w) => ({
        abi: MORPHO_ABI,
        address: morphoAddress,
        functionName: "idToMarketParams",
        args: [w.marketId as `0x${string}`],
      })),
      allowFailure: false,
    })) as unknown as MarketParams[];

    const resolved = withdrawals
      .map((w, i) => ({ marketParams: marketParamsList[i], amount: w.amount, marketId: w.marketId }))
      .sort((a, b) => (a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0));

    const fee = vaultFeeMap.get(vaultAddress) ?? 0n;
    totalFee += fee;

    params.push({
      vault: vaultAddress,
      fee,
      withdrawals: resolved.map((r) => ({ marketParams: r.marketParams, amount: r.amount })),
      supplyMarketParams: market.marketParams,
    });
  }

  return { params, totalFee };
}
