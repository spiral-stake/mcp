// Manage + close tx builder — the non-custodial adjustment surface for an OPEN position. Ports the
// app's manage cards (Increase/Repay/Supply/Withdraw) + the close (deleverage) flow into one pure
// function that returns an UNSIGNED tx the agent's wallet signs. Never signs, sends, or holds keys.
//
// Actions (all operate on an existing position, identified by its on-chain index `id`):
//   close             FlashLeverage.deleverage        swap ALL collateral -> loan, repay debt, return rest
//   increase_leverage FlashLeverage.increaseLeverage  flash-borrow to a higher LTV, swap loan -> collateral
//   add_collateral    supplyCollateral / swapAndSupplyCollateral   top up (direct, or zap another token)
//   repay             repay / swapAndRepay            pay down debt (direct, or zap); `full` clears it
//   remove_collateral FlashLeverage.withdrawCollateral   pull collateral out (no swap)
//   borrow            FlashLeverage.borrow            borrow more loan token (no swap)
//
// Swap fee parity with the app: close + increase charge NO fee (chargeFee=false); the zap swaps for
// add_collateral/repay charge the standard fee (default), matching each manage card.
import BigNumber from "bignumber.js";
import { type Abi, encodeFunctionData } from "viem";
import flashLeverageJson from "../abi/FlashLeverage.sol/FlashLeverage.json" with { type: "json" };
import flashLeverageRouterJson from "../abi/FlashLeverageRouter.sol/FlashLeverageRouter.json" with { type: "json" };
import { calcIncreaseLeverageFlashLoanAmount } from "../core/leverage.ts";
import { assertMarketDataFresh } from "../core/freshness.ts";
import { parseUnits } from "../core/formatUnits.ts";
import { readAddresses } from "../data/markets.ts";
import { getSwapData } from "./swap.ts";
import { buildApproveCalls, type Call } from "./approve.ts";
import { resolvePayToken, type ResolvedToken } from "./buildLeverage.ts";
import { portfolioSigningUrl } from "./appLink.ts";
import { readManagePosition, type ManagePosition } from "./positions.ts";
import type { LeveragePosition } from "../types/index.ts";

const FLASH_LEVERAGE_ABI = (flashLeverageJson as { abi: Abi }).abi;
const ROUTER_ABI = (flashLeverageRouterJson as { abi: Abi }).abi;
const MAX_SLIPPAGE = 0.01;
const FULL_REPAY_SHARES = 2n ** 256n - 1n; // sentinel: repay the entire debt (matches the app)

export type ManageAction =
  | "close"
  | "increase_leverage"
  | "add_collateral"
  | "remove_collateral"
  | "repay"
  | "borrow";

export interface ManageTxInput {
  chainId: number;
  userAddress: string;
  id: number; // on-chain position index (from get_positions)
  action: ManageAction;
  amount?: string; // add_collateral | remove_collateral | repay | borrow (human units of payToken/collateral/loan)
  payToken?: string; // add_collateral | repay — token paid in (address; ETH sentinel = zero address)
  full?: boolean; // repay — clear the entire debt
  desiredLtv?: string; // increase_leverage — target LTV percent
  leverage?: number; // increase_leverage — target leverage (LTV = 100*(1 - 1/leverage))
  slippage?: number; // ratio, default 0.005, capped at 0.01
}

export interface ManageTxBundle {
  chainId: number;
  action: ManageAction;
  contractFn: string;
  approvals: Call[];
  tx: { to: string; data: string; value: string };
  meta: {
    id: number;
    positionId: string; // composite `${chainId}-${strategyId}-${id}`
    payToken?: ResolvedToken;
    amountFlashLoan?: string;
    minTokenOut?: string;
    slippage: number;
    expiresAt: string;
    /** One-click handoff: open this in a browser to sign in your own wallet via the Spiral app. */
    signingUrl: string;
    instructions: string;
  };
}

function required(value: string | undefined, name: string, action: string): string {
  if (value == null || value === "") throw new Error(`'${name}' is required for action '${action}'`);
  return value;
}

function targetLtv(input: ManageTxInput, safeLtv: string): string {
  let ltv: number;
  if (input.desiredLtv != null) ltv = Number(input.desiredLtv);
  else if (input.leverage != null && input.leverage > 0) ltv = 100 * (1 - 1 / input.leverage);
  else throw new Error("increase_leverage needs desiredLtv or leverage");
  if (!Number.isFinite(ltv) || ltv <= 0) throw new Error("Invalid target LTV/leverage");
  return Math.min(ltv, Number(safeLtv)).toFixed(2); // never exceed the market's safe LTV
}

export async function buildManageTx(input: ManageTxInput): Promise<ManageTxBundle> {
  const { chainId, userAddress, id, action } = input;
  const slippage = Math.min(input.slippage ?? 0.005, MAX_SLIPPAGE);
  const slippageFactor = BigNumber(1).minus(slippage);
  const minOut = (amountOut: bigint) => BigInt(BigNumber(amountOut.toString()).multipliedBy(slippageFactor).toFixed(0));

  const pos: ManagePosition = await readManagePosition(chainId, userAddress, id);
  if (!pos.open) throw new Error(`Position ${id} is already closed`);
  assertMarketDataFresh(chainId); // fail-closed: never adjust a position off stale market data
  const { market } = pos;
  const collateral = market.collateralToken;
  const loan = market.loanToken;
  const addresses = readAddresses(chainId);
  const flashLeverageAddress = addresses.flashLeverageAddress as string;
  const routerAddress = addresses.flashLeverageRouterAddress as string;

  let to: string;
  let contractFn: string;
  let data: string;
  let value = 0n;
  let approvals: Call[] = [];
  let amountFlashLoan: bigint | undefined;
  let minTokenOut: bigint | undefined;
  let payTokenResolved: ResolvedToken | undefined;

  switch (action) {
    case "close": {
      // Swap the entire collateral back to the loan token, repay the debt, return the remainder.
      const swap = await getSwapData(chainId, collateral.isPt, flashLeverageAddress, collateral.address, loan.address, pos.collateralRaw, slippage, false);
      minTokenOut = minOut(swap.amountOut);
      to = flashLeverageAddress;
      contractFn = "deleverage";
      data = encodeFunctionData({ abi: FLASH_LEVERAGE_ABI, functionName: "deleverage", args: [BigInt(id), 0n, swap.swapData, minTokenOut] });
      break;
    }
    case "increase_leverage": {
      const desiredLtv = targetLtv(input, market.safeLtv);
      // calcIncreaseLeverageFlashLoanAmount only reads amountLeveragedCollateral/amountLoan/market.
      const position = { amountLeveragedCollateral: pos.amountLeveragedCollateral, amountLoan: pos.amountLoan, market } as unknown as LeveragePosition;
      amountFlashLoan = calcIncreaseLeverageFlashLoanAmount(desiredLtv, position);
      if (amountFlashLoan <= 0n) throw new Error("Target LTV is not above the current LTV — nothing to borrow");
      const swap = await getSwapData(chainId, collateral.isPt, flashLeverageAddress, loan.address, collateral.address, amountFlashLoan, slippage, false);
      minTokenOut = minOut(swap.amountOut);
      to = flashLeverageAddress;
      contractFn = "increaseLeverage";
      data = encodeFunctionData({ abi: FLASH_LEVERAGE_ABI, functionName: "increaseLeverage", args: [BigInt(id), amountFlashLoan, swap.swapData, minTokenOut] });
      break;
    }
    case "add_collateral": {
      const amount = required(input.amount, "amount", action);
      payTokenResolved = await resolvePayToken(chainId, market, required(input.payToken, "payToken", action));
      if (payTokenResolved.address.toLowerCase() === collateral.address.toLowerCase()) {
        // Direct: approve the collateral to FlashLeverage, then supplyCollateral.
        to = flashLeverageAddress;
        contractFn = "supplyCollateral";
        approvals = await buildApproveCalls(chainId, userAddress, payTokenResolved, flashLeverageAddress, amount);
        data = encodeFunctionData({ abi: FLASH_LEVERAGE_ABI, functionName: "supplyCollateral", args: [userAddress, BigInt(id), parseUnits(amount, collateral.decimals)] });
      } else {
        // Zap: swap payToken -> collateral via the router.
        const amountIn = parseUnits(amount, payTokenResolved.decimals);
        const swap = await getSwapData(chainId, collateral.isPt, routerAddress, payTokenResolved.address, collateral.address, amountIn, slippage);
        minTokenOut = minOut(swap.amountOut);
        to = routerAddress;
        contractFn = "swapAndSupplyCollateral";
        value = payTokenResolved.isNative ? amountIn : 0n;
        approvals = payTokenResolved.isNative ? [] : await buildApproveCalls(chainId, userAddress, payTokenResolved, routerAddress, amount);
        data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapAndSupplyCollateral", args: [userAddress, BigInt(id), market.morphoMarketId, payTokenResolved.address, amountIn, swap.swapData, minTokenOut] });
      }
      break;
    }
    case "repay": {
      const amount = required(input.amount, "amount", action);
      payTokenResolved = await resolvePayToken(chainId, market, required(input.payToken, "payToken", action));
      const shares = input.full ? FULL_REPAY_SHARES : 0n;
      if (payTokenResolved.address.toLowerCase() === loan.address.toLowerCase()) {
        // Direct: approve the loan token to FlashLeverage, then repay.
        to = flashLeverageAddress;
        contractFn = "repay";
        approvals = await buildApproveCalls(chainId, userAddress, payTokenResolved, flashLeverageAddress, amount);
        data = encodeFunctionData({ abi: FLASH_LEVERAGE_ABI, functionName: "repay", args: [userAddress, BigInt(id), parseUnits(amount, loan.decimals), shares] });
      } else {
        // Zap: swap payToken -> loan via the router (loan token is never a PT, so isPt=false).
        const amountIn = parseUnits(amount, payTokenResolved.decimals);
        const swap = await getSwapData(chainId, false, routerAddress, payTokenResolved.address, loan.address, amountIn, slippage);
        minTokenOut = minOut(swap.amountOut);
        to = routerAddress;
        contractFn = "swapAndRepay";
        value = payTokenResolved.isNative ? amountIn : 0n;
        approvals = payTokenResolved.isNative ? [] : await buildApproveCalls(chainId, userAddress, payTokenResolved, routerAddress, amount);
        data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapAndRepay", args: [userAddress, BigInt(id), market.morphoMarketId, payTokenResolved.address, amountIn, swap.swapData, minTokenOut, shares] });
      }
      break;
    }
    case "remove_collateral": {
      const amount = required(input.amount, "amount", action);
      to = flashLeverageAddress;
      contractFn = "withdrawCollateral";
      data = encodeFunctionData({ abi: FLASH_LEVERAGE_ABI, functionName: "withdrawCollateral", args: [BigInt(id), parseUnits(amount, collateral.decimals)] });
      break;
    }
    case "borrow": {
      const amount = required(input.amount, "amount", action);
      to = flashLeverageAddress;
      contractFn = "borrow";
      data = encodeFunctionData({ abi: FLASH_LEVERAGE_ABI, functionName: "borrow", args: [BigInt(id), parseUnits(amount, loan.decimals)] });
      break;
    }
    default:
      throw new Error(`Unknown action '${action}'`);
  }

  const hasSwap = minTokenOut !== undefined;
  return {
    chainId,
    action,
    contractFn,
    approvals,
    tx: { to, data, value: value.toString() },
    meta: {
      id,
      positionId: `${chainId}-${market.morphoMarketId}-${id}`,
      payToken: payTokenResolved,
      amountFlashLoan: amountFlashLoan?.toString(),
      minTokenOut: minTokenOut?.toString(),
      slippage,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signingUrl: portfolioSigningUrl(chainId, id),
      instructions:
        `To execute: either open meta.signingUrl to manage this position and sign in your own wallet ` +
        `via the Spiral app (recommended), or sign the raw payload yourself. Non-custodial: built for ` +
        `${userAddress}; that wallet must sign. ${approvals.length} approval(s) first (if any), then the tx. ` +
        (hasSwap ? "Embedded swap calldata expires ~60s after build — rebuild if stale. " : "") +
        "Verify with get_positions after it confirms.",
    },
  };
}
