// Open-leverage simulate + tx builder — the non-custodial core of the execution surface. Ports the
// app's StrategyPage open flow (fetchSwapData + handleLeverage) into pure functions:
//   • simulateLeverage  -> a DETERMINISTIC position preview (uniform for ETH and ERC-20 — no on-chain
//                          eth_call, no per-token branching). What the resulting position looks like.
//   • buildLeverageTx    -> the same preview PLUS the UNSIGNED tx bundle the agent's wallet signs.
// Neither signs, sends, nor holds keys.
//
// Both share prepareLeverage(), which auto-selects one of the app's four paths in the background:
//   isDirect     = payToken == collateral            (else router: pre-swap payToken -> collateral)
//   isReallocate = liquidityAssetsParsed <= flashLoan (else normal)
//     direct  + normal      -> FlashLeverage.leverage
//     router  + normal      -> FlashLeverageRouter.swapAndLeverage
//     direct  + reallocate  -> FlashLeverageRouter.reallocateAndLeverage
//     router  + reallocate  -> FlashLeverageRouter.reallocateSwapAndLeverage
// Approvals mirror the app (ERC-20 pay token; none for native ETH). msg.value = ETH collateral (when
// paying in ETH) + the sum of public-allocator fees (when reallocating).
import BigNumber from "bignumber.js";
import { type Abi, encodeFunctionData } from "viem";
import flashLeverageJson from "../abi/FlashLeverage.sol/FlashLeverage.json" with { type: "json" };
import flashLeverageRouterJson from "../abi/FlashLeverageRouter.sol/FlashLeverageRouter.json" with { type: "json" };
import { calcFlashLoanAmount, calcLeverage, calcLeverageApy, calcLtv, oracleReferenceOut } from "../core/leverage.ts";
import { formatUnits, parseUnits } from "../core/formatUnits.ts";
import { buildEquityMarkets } from "../core/equity.ts";
import { composeSnapshot } from "../core/compose.ts";
import { assertMarketDataFresh } from "../core/freshness.ts";
import { readAddresses, readToken } from "../data/markets.ts";
import { getClient } from "../sources/onchain.ts";
import { getSwapData, swapFeeBps, type SwapData, type SwapResult, type SwapSource } from "./swap.ts";
import { buildApproveCalls, type Call } from "./approve.ts";
import { buildReallocateParams } from "./reallocate.ts";
import { openSigningUrl } from "./appLink.ts";
import type { Market, ReallocateParams } from "../types/index.ts";

const FLASH_LEVERAGE_ABI = (flashLeverageJson as { abi: Abi }).abi;
const ROUTER_ABI = (flashLeverageRouterJson as { abi: Abi }).abi;
// Standard ERC-20 metadata reads for resolving an arbitrary pay token's decimals/symbol on-chain.
const ERC20_META_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_SLIPPAGE = 0.01; // 1% — mirrors swapAggregator.MAX_SLIPPAGE

type LeveragePath = "leverage" | "swapAndLeverage" | "reallocateAndLeverage" | "reallocateSwapAndLeverage";

export interface SimulateLeverageInput {
  chainId: number;
  strategyId: string; // morphoMarketId
  payToken: string; // token the agent pays in (address; ETH sentinel = zero address)
  amount: string; // human units of payToken
  desiredLtv?: string; // percentage, e.g. "50" — provide this OR leverage
  leverage?: number; // e.g. 3 — converted to LTV = 100*(1 - 1/leverage)
  slippage?: number; // ratio, default 0.005; capped at MAX_SLIPPAGE
}
export interface BuildLeverageInput extends SimulateLeverageInput {
  userAddress: string; // the wallet that will sign; approvals + onBehalfOf are built for it
}

export interface ResolvedToken {
  address: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

export interface PositionPreview {
  leverage: string;
  requestedLtv: string;
  effectiveLtv: string;
  amountLeveragedCollateral: string;
  expectedLeverageApy: string;
  priceImpactPct: string;
  /** Which aggregator won the leverage-swap race (KyberSwap/OpenOcean/Pendle). */
  swapSource: SwapSource;
}

export interface SimulateLeverageResult {
  chainId: number;
  strategyId: string;
  action: "open_leverage";
  path: LeveragePath;
  isDirect: boolean;
  isReallocate: boolean;
  payToken: ResolvedToken;
  amount: string;
  positionPreview: PositionPreview;
  amountFlashLoan: string;
  minTokenOut: string;
  externalMinTokenOut?: string;
  reallocationFeeWei?: string; // sum of public-allocator fees added to msg.value (reallocate paths)
  slippage: number;
  note: string;
}

export interface UnsignedTxBundle {
  chainId: number;
  action: "open_leverage";
  path: LeveragePath;
  approvals: Call[];
  tx: { to: string; data: string; value: string };
  meta: {
    isDirect: boolean;
    isReallocate: boolean;
    payToken: ResolvedToken;
    amountFlashLoan: string;
    minTokenOut: string;
    externalMinTokenOut?: string;
    positionPreview: PositionPreview;
    slippage: number;
    expiresAt: string;
    /** One-click handoff: open this in a browser to sign in your own wallet via the Spiral app. */
    signingUrl: string;
    instructions: string;
  };
}

// Everything both simulate and build need, computed deterministically from the inputs + a live swap
// quote. No userAddress dependency — the preview is address-independent.
interface PreparedLeverage {
  chainId: number;
  market: Market;
  flashLeverageAddress: string;
  routerAddress: string;
  desiredLtv: string;
  slippage: number;
  payToken: ResolvedToken;
  isDirect: boolean;
  isReallocate: boolean;
  path: LeveragePath;
  amountFlashLoan: bigint;
  amountInParsed: bigint;
  minTokenOut: bigint;
  externalMinTokenOut?: bigint;
  externalSwapData?: SwapData;
  leverageSwap: SwapResult;
  leverageParams: {
    marketId: string;
    amountCollateral: bigint;
    amountFlashLoan: bigint;
    swapData: SwapData;
    minTokenOut: bigint;
  };
  ethValue: bigint;
  reallocate?: { params: ReallocateParams[]; totalFee: bigint };
  preview: PositionPreview;
}

// Resolve payToken -> {address, symbol, decimals, isNative}. Known tokens (collateral, loan, ETH)
// resolve locally; anything else is read on-chain (decimals + symbol). Fail-closed on bad addresses.
export async function resolvePayToken(chainId: number, market: Market, payToken: string): Promise<ResolvedToken> {
  const addr = payToken.toLowerCase();
  const ethAddress = (readToken(chainId, "ETH")?.address ?? ZERO).toLowerCase();
  if (addr === ethAddress || addr === ZERO)
    return { address: payToken, symbol: "ETH", decimals: 18, isNative: true };
  if (addr === market.collateralToken.address.toLowerCase())
    return { address: market.collateralToken.address, symbol: market.collateralToken.symbol, decimals: market.collateralToken.decimals, isNative: false };
  if (addr === market.loanToken.address.toLowerCase())
    return { address: market.loanToken.address, symbol: market.loanToken.symbol, decimals: market.loanToken.decimals, isNative: false };

  const client = getClient(chainId);
  const [decimals, symbol] = await Promise.all([
    client.readContract({ abi: ERC20_META_ABI, address: payToken as `0x${string}`, functionName: "decimals" }) as Promise<number>,
    client.readContract({ abi: ERC20_META_ABI, address: payToken as `0x${string}`, functionName: "symbol" }) as Promise<string>,
  ]);
  return { address: payToken, symbol, decimals: Number(decimals), isNative: false };
}

function ltvFromInput(input: SimulateLeverageInput, market: Market): string {
  let ltv: number;
  if (input.desiredLtv != null) ltv = Number(input.desiredLtv);
  else if (input.leverage != null && input.leverage > 0) ltv = 100 * (1 - 1 / input.leverage);
  else throw new Error("Provide either desiredLtv or leverage");
  if (!Number.isFinite(ltv) || ltv <= 0) throw new Error("Invalid leverage/LTV");
  // Clamp to the market's safe LTV — the app's slider ceiling. Never exceed it (fail-closed).
  return Math.min(ltv, Number(market.safeLtv)).toFixed(2);
}

async function prepareLeverage(input: SimulateLeverageInput): Promise<PreparedLeverage> {
  const { chainId, strategyId } = input;
  const slippage = Math.min(input.slippage ?? 0.005, MAX_SLIPPAGE);

  // 1. Resolve the market from the live composition. Guardrail: must be leverageable.
  const snap = composeSnapshot(chainId);
  const cm = snap.markets.find((m) => m.market.morphoMarketId === strategyId);
  if (!cm) {
    // Equity vaults are surfaced in /v1/strategies for discovery, but they're deposited through the
    // app's vault flow (USDG → stock collateral + yield loop), not this leverage endpoint — so give a
    // clear signal rather than "unknown" when an agent tries to size one here.
    const isEquity = buildEquityMarkets(chainId, snap.markets.map((m) => m.market)).some(
      (m) => m.morphoMarketId.toLowerCase() === strategyId.toLowerCase(),
    );
    throw new Error(
      isEquity
        ? "Equity vaults are deposited via the Spiral app, not through leverage — open the strategy's links.app to deposit."
        : `Unknown strategy ${strategyId}`,
    );
  }
  const market = cm.market;
  // Both profiles are leverageable through the same swapAndLeverage path — correlated yield loops and
  // uncorrelated perps alike. Equity vaults are synthetic and never enter this snapshot, so they're
  // already excluded above ("Unknown strategy"); `visible` is the real eligibility gate.
  if (!market.visible) throw new Error("Market is not currently eligible for leverage");
  assertMarketDataFresh(chainId); // fail-closed: never size a position off stale market data

  const addresses = readAddresses(chainId);
  const flashLeverageAddress = addresses.flashLeverageAddress as string;
  const routerAddress = addresses.flashLeverageRouterAddress as string;

  const desiredLtv = ltvFromInput(input, market);
  const payToken = await resolvePayToken(chainId, market, input.payToken);
  const isDirect = payToken.address.toLowerCase() === market.collateralToken.address.toLowerCase();
  const isPt = market.collateralToken.isPt;
  const slippageFactor = BigNumber(1).minus(slippage);

  // 2. fetchSwapData — size the flash loan, then build the borrow->collateral swap calldata.
  let amountFlashLoan: bigint;
  let amountSwappedCollateral: string | undefined; // human units (router path only)
  let externalSwapData: SwapData | undefined;
  let externalMinTokenOut: bigint | undefined;

  if (isDirect) {
    amountFlashLoan = calcFlashLoanAmount(desiredLtv, market, input.amount);
  } else {
    const amountIn = parseUnits(input.amount, payToken.decimals);
    const ext = await getSwapData(chainId, isPt, routerAddress, payToken.address, market.collateralToken.address, amountIn, slippage, swapFeeBps(market), oracleReferenceOut(market, payToken.address, amountIn, market.collateralToken.address));
    externalSwapData = ext.swapData;
    externalMinTokenOut = BigInt(BigNumber(ext.amountOut.toString()).multipliedBy(slippageFactor).toFixed(0));
    amountSwappedCollateral = formatUnits(ext.amountOut, market.collateralToken.decimals).toString();
    amountFlashLoan = calcFlashLoanAmount(desiredLtv, market, amountSwappedCollateral);
  }

  const leverageSwap = await getSwapData(chainId, isPt, flashLeverageAddress, market.loanToken.address, market.collateralToken.address, amountFlashLoan, slippage, swapFeeBps(market), oracleReferenceOut(market, market.loanToken.address, amountFlashLoan, market.collateralToken.address));
  const minTokenOut = BigInt(BigNumber(leverageSwap.amountOut.toString()).multipliedBy(slippageFactor).toFixed(0));

  // 3. leverageParams — identical shape to the app / the FlashLeverage ABI tuple.
  const leverageParams = {
    marketId: market.morphoMarketId,
    amountCollateral: isDirect ? parseUnits(input.amount, market.collateralToken.decimals) : externalMinTokenOut ?? 0n,
    amountFlashLoan,
    swapData: leverageSwap.swapData,
    minTokenOut,
  };

  // 4. Path selection + native ETH value + reallocation params/fee (deterministic).
  const isReallocate = market.liquidityAssetsParsed <= amountFlashLoan;
  const ethValue = payToken.isNative ? parseUnits(input.amount, 18) : 0n;
  const reallocate = isReallocate ? await buildReallocateParams(chainId, market, amountFlashLoan) : undefined;
  const path: LeveragePath = !isReallocate
    ? isDirect ? "leverage" : "swapAndLeverage"
    : isDirect ? "reallocateAndLeverage" : "reallocateSwapAndLeverage";

  // 5. Position preview (deterministic from params) + price impact.
  const totalCollateral = formatUnits(leverageSwap.amountOut, market.collateralToken.decimals).plus(amountSwappedCollateral ?? input.amount);
  const effectiveLtv = calcLtv(totalCollateral, formatUnits(amountFlashLoan, market.loanToken.decimals), market.collateralTokenValueInLoanToken);
  // Price impact from the app's own token prices — one formula for every venue. Venue-reported
  // impact is unreliable (KyberSwap misprices some stables in routeSummary; OpenOcean can report
  // positive impact on a gaining quote), so we never trust it.
  const inUsd = formatUnits(amountFlashLoan, market.loanToken.decimals).multipliedBy(market.loanToken.valueInUsd);
  const outUsd = formatUnits(leverageSwap.amountOut, market.collateralToken.decimals).multipliedBy(market.collateralToken.valueInUsd);
  const priceImpactPct = inUsd.isZero() ? "0.00" : inUsd.minus(outUsd).div(inUsd).multipliedBy(100).toFixed(2);

  const preview: PositionPreview = {
    leverage: calcLeverage(desiredLtv),
    requestedLtv: desiredLtv,
    effectiveLtv,
    amountLeveragedCollateral: totalCollateral.toFixed(4, BigNumber.ROUND_DOWN),
    // Effective collateral yield = base APY + collateral-side Merkl incentive, exactly as
    // compose.ts sizes defaultLeverageApy and strategy.ts sizes the leverage ladder. Using the
    // bare base APY here made the preview contradict /v1/strategies (and the app) on any market
    // whose yield is incentive-dominated — e.g. 0% base + 4.5% incentive previews as a large
    // NEGATIVE levered APY, because the borrow leg is still netted off.
    // Pass `true` (not market.correlated) so the perp carry is the honest signed figure — matching
    // /v1/strategies' leverageApyPct exactly (see strategy.ts honestLeverageApy). For a correlated
    // loop this is identical; for a perp it's the un-flipped negative carry rather than the app's
    // sign-flipped "Borrow APY" display value, keeping the two MCP surfaces in parity.
    expectedLeverageApy: calcLeverageApy(
      true,
      BigNumber(market.collateralToken.apy).plus(market.collateralIncentiveApy ?? "0").toFixed(2),
      BigNumber(market.borrowApy).minus(market.borrowIncentiveApy).toFixed(2),
      desiredLtv,
    ),
    priceImpactPct,
    swapSource: leverageSwap.source,
  };

  return {
    chainId, market, flashLeverageAddress, routerAddress, desiredLtv, slippage, payToken,
    isDirect, isReallocate, path, amountFlashLoan, amountInParsed: parseUnits(input.amount, payToken.decimals),
    minTokenOut, externalMinTokenOut, externalSwapData, leverageSwap, leverageParams, ethValue, reallocate, preview,
  };
}

// Deterministic position preview — uniform for ETH and ERC-20. Read-only; no wallet needed.
export async function simulateLeverage(input: SimulateLeverageInput): Promise<SimulateLeverageResult> {
  const p = await prepareLeverage(input);
  return {
    chainId: p.chainId,
    strategyId: input.strategyId,
    action: "open_leverage",
    path: p.path,
    isDirect: p.isDirect,
    isReallocate: p.isReallocate,
    payToken: p.payToken,
    amount: input.amount,
    positionPreview: p.preview,
    amountFlashLoan: p.amountFlashLoan.toString(),
    minTokenOut: p.minTokenOut.toString(),
    externalMinTokenOut: p.externalMinTokenOut?.toString(),
    reallocationFeeWei: p.reallocate?.totalFee.toString(),
    slippage: p.slippage,
    note:
      "Deterministic preview from live swap quotes. Non-custodial: call build_leverage_tx with your " +
      "wallet address to get the unsigned transaction to sign. Numbers move with market prices — " +
      "rebuild right before signing.",
  };
}

// The unsigned tx bundle the agent's wallet signs. Adds approvals (needs userAddress) + encoded tx.
export async function buildLeverageTx(input: BuildLeverageInput): Promise<UnsignedTxBundle> {
  const p = await prepareLeverage(input);
  const { chainId, isDirect, path, payToken, leverageParams } = p;

  // Approvals mirror the app: ERC-20 pay token -> approve the spender; native ETH -> none.
  let approvals: Call[] = [];
  if (!payToken.isNative) {
    const spender = isDirect ? p.flashLeverageAddress : p.routerAddress;
    approvals = await buildApproveCalls(chainId, input.userAddress, payToken, spender, input.amount);
  }

  // Encode the auto-selected path. Reallocate paths add the summed PA fees to msg.value.
  let to: string;
  let data: string;
  let value = p.ethValue;
  switch (path) {
    case "leverage":
      to = p.flashLeverageAddress;
      data = encodeFunctionData({ abi: FLASH_LEVERAGE_ABI, functionName: "leverage", args: [input.userAddress, leverageParams] });
      break;
    case "swapAndLeverage":
      to = p.routerAddress;
      data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapAndLeverage", args: [payToken.address, p.amountInParsed, p.externalSwapData, p.externalMinTokenOut, leverageParams] });
      break;
    case "reallocateAndLeverage":
      to = p.routerAddress;
      value = p.ethValue + p.reallocate!.totalFee;
      data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "reallocateAndLeverage", args: [p.reallocate!.params, leverageParams] });
      break;
    case "reallocateSwapAndLeverage":
      to = p.routerAddress;
      value = p.ethValue + p.reallocate!.totalFee;
      data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "reallocateSwapAndLeverage", args: [p.reallocate!.params, payToken.address, p.amountInParsed, p.externalSwapData, p.externalMinTokenOut, leverageParams] });
      break;
  }

  return {
    chainId,
    action: "open_leverage",
    path,
    approvals,
    tx: { to, data, value: value.toString() },
    meta: {
      isDirect,
      isReallocate: p.isReallocate,
      payToken,
      amountFlashLoan: p.amountFlashLoan.toString(),
      minTokenOut: p.minTokenOut.toString(),
      externalMinTokenOut: p.externalMinTokenOut?.toString(),
      positionPreview: p.preview,
      slippage: p.slippage,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), // swap calldata is time-sensitive
      signingUrl: openSigningUrl(chainId, input.strategyId, p.desiredLtv, input.amount, payToken.address),
      instructions:
        `To execute: either (a) open meta.signingUrl in a browser to review and sign in your own wallet ` +
        `via the Spiral app (recommended), or (b) sign the raw payload yourself — ${approvals.length} approval(s) ` +
        `first (if any), then the tx. Non-custodial: built for ${input.userAddress}; that wallet must sign. ` +
        `Swap calldata expires ~60s after build — rebuild if stale.`,
    },
  };
}
