// Equity-vault execution — the non-custodial deposit / exit surface for the "stock + yield" vaults.
// Ports the app's utils/equityVaultTx.ts (entry + exit builders) and utils/equityPosition.ts (which
// open loops belong to a vault) into pure functions that return UNSIGNED call batches the agent's
// wallet signs. Never signs, sends, or holds keys.
//
// A vault is two legs the user holds directly (msg.sender = user throughout):
//   1. STOCK leg — the deposit (USDG) is swapped to the stock and posted as the user's own collateral
//      on the partner's Morpho market (Longbow / NetNet Credit); `stockLtvPct` of its value is
//      borrowed back as USDG.
//   2. YIELD leg — that borrowed USDG is zapped into the yield collateral and flash-looped on Spiral's
//      FlashLeverage at the yield market's max-safe LTV (its safeLtv), as a normal loop position.
//
// Deposit = ONE router call (FlashLeverageRouter.equityEntry on the equity router) wrapped in the
// Morpho manager authorization it needs, as a 4-call batch:
//   [ approve USDG→router · morpho.setAuthorization(router,true) · router.equityEntry · setAuthorization(router,false) ]
// Exit = close every yield loop the vault owns (deleverage is owner-gated on the core, so the user's
// own calls), then ONE self-funded router call unwinds the stock leg (flash-loan repay → withdraw the
// stock → swap to USDG → return the proceeds), again inside an authorize/revoke pair:
//   [ core.deleverage × N · setAuthorization(router,true) · router.equityExit · setAuthorization(router,false) ]
// Both batches are meant to run ATOMICALLY (EIP-5792 wallet_sendCalls — the app's Base.writes). A
// wallet that can't batch may send them in order; the trailing revoke must always be sent.
import BigNumber from "bignumber.js";
import { encodeFunctionData } from "viem";
import { calcFlashLoanAmount, oracleReferenceOut } from "../core/leverage.ts";
import { formatUnits, parseUnits } from "../core/formatUnits.ts";
import { buildEquityMarkets } from "../core/equity.ts";
import { composeSnapshot } from "../core/compose.ts";
import { isAgentEligible } from "../core/strategy.ts";
import { assertMarketDataFresh } from "../core/freshness.ts";
import { readAddresses } from "../data/markets.ts";
import { getClient } from "../sources/onchain.ts";
import { getSwapData, SWAP_FEE_BPS, NON_CORRELATED_SWAP_FEE_BPS, type SwapSource } from "./swap.ts";
import { buildApproveCalls, type Call } from "./approve.ts";
import { openSigningUrl, portfolioSigningUrl } from "./appLink.ts";
import { getUserPositions, readManagePosition, type LeveragePositionView } from "./positions.ts";
import type { Market, EquityVaultInfo } from "../types/index.ts";

// The equity router's two entry points + Morpho's manager authorization. The router is a separate
// deployment (addresses/{chain}.json `equityRouterAddress`); its ABI is not in the synced
// FlashLeverageRouter.json, so — as in the app — the minimal ABI lives here.
const SWAP_DATA_TUPLE = {
  type: "tuple",
  components: [
    { name: "extRouter", type: "address" },
    { name: "extCalldata", type: "bytes" },
  ],
} as const;
export const EQUITY_ROUTER_ABI = [
  {
    type: "function",
    name: "equityEntry",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "depositToken", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "stockSwapData", ...SWAP_DATA_TUPLE },
          { name: "stockMinOut", type: "uint256" },
          { name: "stockMarketId", type: "bytes32" },
          { name: "stockBorrowAmount", type: "uint256" },
          { name: "yieldSwapData", ...SWAP_DATA_TUPLE },
          { name: "yieldMinOut", type: "uint256" },
          {
            name: "leverageParams",
            type: "tuple",
            components: [
              { name: "marketId", type: "bytes32" },
              { name: "amountCollateral", type: "uint256" },
              { name: "amountFlashLoan", type: "uint256" },
              { name: "swapData", ...SWAP_DATA_TUPLE },
              { name: "minTokenOut", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "equityExit",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "stockMarketId", type: "bytes32" },
          { name: "stockSwapData", ...SWAP_DATA_TUPLE },
          { name: "minLoanOut", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;
export const MORPHO_AUTH_ABI = [
  {
    type: "function",
    name: "setAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "authorized", type: "address" },
      { name: "newIsAuthorized", type: "bool" },
    ],
    outputs: [],
  },
] as const;
const FLASH_LEVERAGE_DELEVERAGE_ABI = [
  {
    type: "function",
    name: "deleverage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "amountCollateral", type: "uint256" },
      { name: "swapData", ...SWAP_DATA_TUPLE },
      { name: "minTokenOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

// The app pins equity-vault slippage to 1% (StrategyPage.initialize; EquityPositionCard.handleClose).
const EQUITY_SLIPPAGE = 0.01;
const MAX_SLIPPAGE = 0.01;
// Contract-side safety on the stock borrow (FlashLeverageRouter.LIQUIDATION_BUFFER): the borrow may
// not exceed collateral × (LLTV − 0.25%). We check the same bound off-chain so a build never encodes
// a borrow the router would reject.
const ROUTER_LIQUIDATION_BUFFER_PCT = 0.25;
// Least price drop a stock leg may open with before it liquidates: the LTV cap is
// liqLtv × (1 − this). At 12%, a 62.5% LLTV stock market caps the input at 55%. Mirrors the app's
// utils/equityLtv.ts (the deposit panel's slider ceiling).
const MIN_LIQUIDATION_DROP = 0.12;
export const maxStockLtvPct = (ev: EquityVaultInfo): number =>
  Number(BigNumber(ev.liqLtvPct).multipliedBy(1 - MIN_LIQUIDATION_DROP).toFixed(2, BigNumber.ROUND_DOWN));
// Exit floor buffer on the stock debt (interest accrued between build and mine) — as the app.
const EXIT_DEBT_BUFFER = 1.005;

const minOut = (amountOut: bigint, slippage: number): bigint =>
  BigInt(BigNumber(amountOut.toString()).multipliedBy(BigNumber(1).minus(slippage)).toFixed(0));

// ── shared resolution ─────────────────────────────────────────────────────────────────────────────
interface ResolvedVault {
  chainId: number;
  equityMarket: Market; // synthetic vault market (stock as collateral, USDG loan)
  ev: EquityVaultInfo;
  yieldMarket: Market; // the Spiral loop market the borrowed USDG is deployed into
  router: string; // equity router
  flashLeverageAddress: string;
}

function resolveVault(chainId: number, strategyId: string): ResolvedVault {
  const snap = composeSnapshot(chainId);
  const loops = snap.markets.map((m) => m.market);
  const equityMarket = buildEquityMarkets(chainId, loops).find(
    (m) => m.morphoMarketId.toLowerCase() === strategyId.toLowerCase(),
  );
  if (!equityMarket?.equityVault) {
    throw new Error(
      loops.some((m) => m.morphoMarketId.toLowerCase() === strategyId.toLowerCase())
        ? `${strategyId} is a leverage strategy, not an equity vault — use simulate_leverage / build_leverage_tx.`
        : `Unknown equity vault ${strategyId}`,
    );
  }
  if (!isAgentEligible(equityMarket)) throw new Error("Equity vault is not currently eligible");
  const ev = equityMarket.equityVault;
  const yieldMarket = loops.find((m) => m.morphoMarketId.toLowerCase() === ev.yieldMarketId.toLowerCase());
  if (!yieldMarket) throw new Error(`Equity vault ${strategyId}: its yield market ${ev.yieldMarketId} is not configured`);
  const addresses = readAddresses(chainId);
  const router = addresses.equityRouterAddress as string | undefined;
  if (!router) throw new Error(`No equity router configured for chainId ${chainId}`);
  return { chainId, equityMarket, ev, yieldMarket, router, flashLeverageAddress: addresses.flashLeverageAddress as string };
}

const stockMarketParamsTuple = (ev: EquityVaultInfo) => ({
  loanToken: ev.stockMarketParams.loanToken as `0x${string}`,
  collateralToken: ev.stockMarketParams.collateralToken as `0x${string}`,
  oracle: ev.stockMarketParams.oracle as `0x${string}`,
  irm: ev.stockMarketParams.irm as `0x${string}`,
  lltv: BigInt(ev.stockMarketParams.lltv),
});

const authorizeCall = (morpho: string, router: string, on: boolean): Call => ({
  to: morpho,
  data: encodeFunctionData({ abi: MORPHO_AUTH_ABI, functionName: "setAuthorization", args: [router as `0x${string}`, on] }),
});

// ── deposit ───────────────────────────────────────────────────────────────────────────────────────
export interface SimulateEquityDepositInput {
  chainId: number;
  strategyId: string; // the vault's id ("equity-0x…", from list_strategies)
  amount: string; // human units of the deposit token (USDG)
  stockLtvPct?: string; // stock-leg LTV percent; default = the vault's targetLtvPct, capped at maxStockLtvPct
  slippage?: number; // ratio, default 0.01 (the app's equity setting), capped at 0.01
}
export interface BuildEquityDepositInput extends SimulateEquityDepositInput {
  userAddress: string;
}

export interface EquityDepositPreview {
  depositToken: { address: string; symbol: string; decimals: number };
  depositAmount: string;
  stock: {
    symbol: string;
    address: string;
    priceUsd: string;
    /** Minimum stock received from the deposit swap (the router supplies what it actually gets, ≥ this). */
    minReceived: string;
    ltvPct: string; // requested stock-leg LTV
    maxLtvPct: string; // the cap this input is clamped to
    liquidationLtvPct: string;
    /** Stock price at which the stock leg reaches its liquidation LTV (from the entry price). */
    liquidationPriceUsd: string;
    priceDropToLiquidationPct: string;
    borrowUsdg: string; // USDG borrowed against the stock and deployed into the yield loop
    borrowApyPct: string; // the stock market's USDG borrow APR
    swapSource: SwapSource;
    priceImpactPct: string;
  };
  yieldLeg: {
    strategyId: string;
    collateralSymbol: string;
    collateralIn: string; // yield collateral bought with the borrowed USDG (the loop's own deposit)
    leverage: string; // fixed at the yield market's max-safe LTV
    ltvPct: string;
    amountFlashLoan: string;
    leverageApyPct: string;
    swapSource: SwapSource;
    priceImpactPct: string;
  };
  /** Net dollar APY on the deposit at THIS stock LTV: ltv × (yieldLegApy − stockBorrowApy). */
  netApyPct: string;
  fees: { stockLegBps: number; yieldLegBps: number; estimatedFeeUsd: string };
  slippage: number;
}

interface PreparedDeposit extends ResolvedVault {
  amountInRaw: bigint;
  entryParams: {
    depositToken: `0x${string}`;
    amountIn: bigint;
    stockSwapData: { extRouter: `0x${string}`; extCalldata: `0x${string}` };
    stockMinOut: bigint;
    stockMarketId: `0x${string}`;
    stockBorrowAmount: bigint;
    yieldSwapData: { extRouter: `0x${string}`; extCalldata: `0x${string}` };
    yieldMinOut: bigint;
    leverageParams: {
      marketId: `0x${string}`;
      amountCollateral: bigint;
      amountFlashLoan: bigint;
      swapData: { extRouter: `0x${string}`; extCalldata: `0x${string}` };
      minTokenOut: bigint;
    };
  };
  preview: EquityDepositPreview;
  slippage: number;
}

async function prepareDeposit(input: SimulateEquityDepositInput): Promise<PreparedDeposit> {
  const vault = resolveVault(input.chainId, input.strategyId);
  const { chainId, equityMarket, ev, yieldMarket, router, flashLeverageAddress } = vault;
  assertMarketDataFresh(chainId); // fail-closed: never size a position off stale market data
  const slippage = Math.min(input.slippage ?? EQUITY_SLIPPAGE, MAX_SLIPPAGE);

  const usdg = equityMarket.loanToken;
  const stock = equityMarket.collateralToken;
  const yieldCollateral = yieldMarket.collateralToken;

  const amount = BigNumber(input.amount);
  if (!amount.isFinite() || amount.lte(0)) throw new Error("amount must be a positive number");
  const amountInRaw = parseUnits(amount.toFixed(usdg.decimals, BigNumber.ROUND_DOWN), usdg.decimals);

  // Stock-leg LTV: the vault's default unless chosen; never above the cap (fail-closed, not clamped —
  // an agent that asked for 60 must not silently get 55).
  const maxLtv = maxStockLtvPct(ev);
  const ltv = BigNumber(input.stockLtvPct ?? ev.targetLtvPct);
  if (!ltv.isFinite() || ltv.lte(0)) throw new Error("stockLtvPct must be a positive percent");
  if (ltv.gt(maxLtv)) {
    throw new Error(
      `stockLtvPct ${ltv.toFixed(2)}% is above the ${maxLtv.toFixed(2)}% cap for ${stock.symbol} ` +
        `(liquidation at ${BigNumber(ev.liqLtvPct).toFixed(2)}%; the cap keeps at least a ${MIN_LIQUIDATION_DROP * 100}% price drop of headroom).`,
    );
  }

  // Leg 1a: swap USDG → stock, delivered to the router (which supplies it as the user's collateral).
  // Price exposure, not a yield loop, so it carries the non-correlated fee.
  const stockSwap = await getSwapData(
    chainId, false, router, usdg.address, stock.address, amountInRaw, slippage, NON_CORRELATED_SWAP_FEE_BPS,
    oracleReferenceOut(equityMarket, usdg.address, amountInRaw, stock.address),
  );
  const stockMinOut = minOut(stockSwap.amountOut, slippage);
  const stockWhole = formatUnits(stockMinOut, stock.decimals);
  const stockPrice = BigNumber(ev.stockPriceUsd);

  // Borrow the chosen LTV against the conservative (min-out) stock value; the router supplies the
  // actual received (≥), so the on-chain LTV lands at or below the request.
  const borrowUsd = stockWhole.multipliedBy(stockPrice).multipliedBy(ltv.div(100));
  const borrowRaw = parseUnits(borrowUsd.toFixed(usdg.decimals, BigNumber.ROUND_DOWN), usdg.decimals);
  if (borrowRaw <= 0n) throw new Error("Deposit too small: the stock-leg borrow rounds to zero");
  // The router's own bound (collateral × (LLTV − 0.25%)), evaluated on the min-out collateral.
  const routerMaxBorrowUsd = stockWhole.multipliedBy(stockPrice).multipliedBy(BigNumber(ev.liqLtvPct).minus(ROUTER_LIQUIDATION_BUFFER_PCT).div(100));
  if (borrowUsd.gt(routerMaxBorrowUsd)) throw new Error("Stock-leg borrow exceeds the router's LTV bound — lower stockLtvPct");
  // The stock market must have that much USDG to lend (no public-allocator path on a partner market).
  if (borrowRaw > equityMarket.liquidityAssetsParsed) {
    throw new Error(
      `The ${stock.symbol} market has only ${formatUnits(equityMarket.liquidityAssetsParsed, usdg.decimals).toFixed(2)} ${usdg.symbol} ` +
        `available to borrow; this deposit needs ${formatUnits(borrowRaw, usdg.decimals).toFixed(2)}. Reduce the amount or stockLtvPct.`,
    );
  }

  // Leg 2: zap the borrowed USDG → yield collateral (to the router), then the flash-loop (to the
  // core). safeLtv is the max-safe LTV the vault's yieldLeverage is derived from — reuse it.
  const zap = await getSwapData(
    chainId, false, router, usdg.address, yieldCollateral.address, borrowRaw, slippage, SWAP_FEE_BPS,
    oracleReferenceOut(yieldMarket, usdg.address, borrowRaw, yieldCollateral.address),
  );
  const zapMinOut = minOut(zap.amountOut, slippage);
  const zapWhole = formatUnits(zap.amountOut, yieldCollateral.decimals);
  const flashLoan = calcFlashLoanAmount(yieldMarket.safeLtv, yieldMarket, zapWhole.toString());
  // equityEntry hands the loop to FlashLeverage.leverage directly (no reallocation path), so the
  // flash loan must fit the yield market's direct liquidity or the whole batch reverts.
  if (yieldMarket.liquidityAssetsParsed <= flashLoan) {
    throw new Error(
      `The ${yieldCollateral.symbol} yield market has ${formatUnits(yieldMarket.liquidityAssetsParsed, usdg.decimals).toFixed(2)} ${usdg.symbol} ` +
        `borrowable; this deposit's yield loop needs ${formatUnits(flashLoan, usdg.decimals).toFixed(2)}. Reduce the amount.`,
    );
  }
  const loopSwap = await getSwapData(
    chainId, false, flashLeverageAddress, usdg.address, yieldCollateral.address, flashLoan, slippage, SWAP_FEE_BPS,
    oracleReferenceOut(yieldMarket, usdg.address, flashLoan, yieldCollateral.address),
  );

  const entryParams: PreparedDeposit["entryParams"] = {
    depositToken: usdg.address as `0x${string}`,
    amountIn: amountInRaw,
    stockSwapData: stockSwap.swapData as PreparedDeposit["entryParams"]["stockSwapData"],
    stockMinOut,
    stockMarketId: ev.stockMarketId as `0x${string}`,
    stockBorrowAmount: borrowRaw,
    yieldSwapData: zap.swapData as PreparedDeposit["entryParams"]["yieldSwapData"],
    yieldMinOut: zapMinOut,
    leverageParams: {
      marketId: yieldMarket.morphoMarketId as `0x${string}`,
      amountCollateral: 0n, // recomputed on-chain from the router's post-zap balance
      amountFlashLoan: flashLoan,
      swapData: loopSwap.swapData as PreparedDeposit["entryParams"]["stockSwapData"],
      minTokenOut: minOut(loopSwap.amountOut, slippage),
    },
  };

  // Preview — from the app's own prices (one formula per leg), as simulate_leverage does.
  const impact = (inUsd: BigNumber, outUsd: BigNumber) =>
    inUsd.isZero() ? "0.00" : inUsd.minus(outUsd).div(inUsd).multipliedBy(100).toFixed(2);
  const depositUsd = amount.multipliedBy(usdg.valueInUsd);
  const borrowWhole = formatUnits(borrowRaw, usdg.decimals);
  const netApyPct = ltv.div(100).multipliedBy(BigNumber(ev.yieldLegApyPct).minus(ev.stockBorrowApyPct)).toFixed(2);
  // Entry swap fee, per leg, as the app's deposit review: the whole deposit at the non-correlated
  // rate; the borrowed USDG is swapped ~yieldLeverage× in total (zap + flash loop) at the standard rate.
  const estimatedFeeUsd = amount
    .multipliedBy(NON_CORRELATED_SWAP_FEE_BPS)
    .plus(borrowWhole.multipliedBy(ev.yieldLeverage).multipliedBy(SWAP_FEE_BPS))
    .div(10_000)
    .multipliedBy(usdg.valueInUsd)
    .toFixed(2);
  const liquidationPrice = stockPrice.multipliedBy(ltv).div(ev.liqLtvPct);

  const preview: EquityDepositPreview = {
    depositToken: { address: usdg.address, symbol: usdg.symbol, decimals: usdg.decimals },
    depositAmount: amount.toFixed(),
    stock: {
      symbol: stock.symbol,
      address: stock.address,
      priceUsd: stockPrice.toFixed(4),
      minReceived: stockWhole.toFixed(6, BigNumber.ROUND_DOWN),
      ltvPct: ltv.toFixed(2),
      maxLtvPct: maxLtv.toFixed(2),
      liquidationLtvPct: BigNumber(ev.liqLtvPct).toFixed(2),
      liquidationPriceUsd: liquidationPrice.toFixed(4),
      priceDropToLiquidationPct: BigNumber(1).minus(ltv.div(ev.liqLtvPct)).multipliedBy(100).toFixed(2),
      borrowUsdg: borrowWhole.toFixed(2),
      borrowApyPct: ev.stockBorrowApyPct,
      swapSource: stockSwap.source,
      priceImpactPct: impact(depositUsd, formatUnits(stockSwap.amountOut, stock.decimals).multipliedBy(stock.valueInUsd)),
    },
    yieldLeg: {
      strategyId: yieldMarket.morphoMarketId,
      collateralSymbol: yieldCollateral.symbol,
      collateralIn: zapWhole.toFixed(6, BigNumber.ROUND_DOWN),
      leverage: ev.yieldLeverage,
      ltvPct: BigNumber(yieldMarket.safeLtv).toFixed(2),
      amountFlashLoan: formatUnits(flashLoan, usdg.decimals).toFixed(2),
      leverageApyPct: ev.yieldLegApyPct,
      swapSource: loopSwap.source,
      priceImpactPct: impact(borrowWhole.multipliedBy(usdg.valueInUsd), zapWhole.multipliedBy(yieldCollateral.valueInUsd)),
    },
    netApyPct,
    fees: { stockLegBps: NON_CORRELATED_SWAP_FEE_BPS, yieldLegBps: SWAP_FEE_BPS, estimatedFeeUsd },
    slippage,
  };

  return { ...vault, amountInRaw, entryParams, preview, slippage };
}

export interface SimulateEquityDepositResult {
  chainId: number;
  strategyId: string;
  action: "equity_deposit";
  preview: EquityDepositPreview;
  note: string;
}

// Deterministic preview from live swap quotes. Read-only; no wallet needed.
export async function simulateEquityDeposit(input: SimulateEquityDepositInput): Promise<SimulateEquityDepositResult> {
  const p = await prepareDeposit(input);
  return {
    chainId: p.chainId,
    strategyId: input.strategyId,
    action: "equity_deposit",
    preview: p.preview,
    note:
      "Deterministic preview from live swap quotes. You stay 1x long the stock; the borrowed USDG earns the " +
      "yield loop's leveraged APY. Non-custodial: call build_equity_deposit_tx with your wallet address for " +
      "the unsigned call batch. Numbers move with prices — rebuild right before signing.",
  };
}

// An ordered, atomic call batch for the user's own wallet (EIP-5792 wallet_sendCalls), the shape the
// app submits. Unlike a single-tx leverage bundle there is no approvals[]/tx split: the Morpho
// authorization the router needs is granted and revoked INSIDE the batch.
export interface EquityCallBundle {
  chainId: number;
  action: "equity_deposit" | "equity_exit";
  strategyId: string;
  calls: Call[];
  atomic: true;
  meta: Record<string, unknown> & { expiresAt: string; signingUrl: string; instructions: string };
}

const BATCH_INSTRUCTIONS =
  "Submit `calls` as ONE atomic batch from the wallet (EIP-5792 wallet_sendCalls / a Safe MultiSend), in order — " +
  "that is how the Spiral app submits it. If the wallet cannot batch, send them one by one in order and ALWAYS send " +
  "the final call (it revokes the Morpho authorization granted earlier in the batch), even if a middle call fails. " +
  "Swap calldata expires ~60s after build — rebuild if stale.";

export async function buildEquityDepositTx(input: BuildEquityDepositInput): Promise<EquityCallBundle> {
  const p = await prepareDeposit(input);
  const usdg = p.equityMarket.loanToken;
  const calls: Call[] = [];
  // 1. approve USDG → equity router (allowance-aware for USDT; a plain approve otherwise, as the app).
  calls.push(...(await buildApproveCalls(p.chainId, input.userAddress, { address: usdg.address, decimals: usdg.decimals, symbol: usdg.symbol }, p.router, formatUnits(p.amountInRaw, usdg.decimals).toFixed())));
  // 2. authorize the router as the user's Morpho manager (for supplyCollateral / borrow on their behalf).
  calls.push(authorizeCall(p.ev.morpho, p.router, true));
  // 3. the one-call entry.
  calls.push({ to: p.router, data: encodeFunctionData({ abi: EQUITY_ROUTER_ABI, functionName: "equityEntry", args: [p.entryParams] }) });
  // 4. revoke — nothing persists after the batch.
  calls.push(authorizeCall(p.ev.morpho, p.router, false));

  return {
    chainId: p.chainId,
    action: "equity_deposit",
    strategyId: input.strategyId,
    calls,
    atomic: true,
    meta: {
      userAddress: input.userAddress,
      preview: p.preview,
      stockBorrowAmount: p.entryParams.stockBorrowAmount.toString(),
      amountFlashLoan: p.entryParams.leverageParams.amountFlashLoan.toString(),
      slippage: p.slippage,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signingUrl: openSigningUrl(p.chainId, input.strategyId, p.preview.stock.ltvPct, input.amount, usdg.address),
      instructions:
        `Deposit ${input.amount} ${usdg.symbol} into the ${p.preview.stock.symbol} + yield vault: ` +
        `either open meta.signingUrl to review and sign in your own wallet via the Spiral app (recommended), or ${BATCH_INSTRUCTIONS} ` +
        `Non-custodial: built for ${input.userAddress}; that wallet must sign.`,
    },
  };
}

// ── positions ─────────────────────────────────────────────────────────────────────────────────────
// Which of a user's open loops on a vault's yield market are that vault's yield leg(s). The app also
// consults its dashboard rows (tagged at open); here every loop is matched on chain facts alone: a
// vault's loop was funded by the USDG the stock leg borrowed for it, so its on-chain deposit basis
// lies in (debt × BASIS_MATCH_MIN, debt × BASIS_MATCH_MAX] — the debt only grows from the borrow.
// Stacked opens on one vault share a single stock leg, so the match is on the SUM of the claimed
// bases (subsets up to MAX_SUBSET_CANDIDATES loops; past that, single loops only).
const BASIS_MATCH_MIN = 0.85; // ≈ 3 years of borrow interest at 5%
const BASIS_MATCH_MAX = 1.02; // rounding / oracle headroom — a basis can't really exceed its borrow
const MAX_SUBSET_CANDIDATES = 10;

export function matchVaultYieldLoops<T extends { amountDepositedInLoanToken: string }>(candidates: T[], stockDebtUsdg: BigNumber): T[] {
  if (candidates.length === 0 || stockDebtUsdg.lte(0)) return [];
  const sumBasis = (loops: T[]) => loops.reduce((t, p) => t.plus(p.amountDepositedInLoanToken), BigNumber(0));
  const lo = stockDebtUsdg.multipliedBy(BASIS_MATCH_MIN);
  const hi = stockDebtUsdg.multipliedBy(BASIS_MATCH_MAX);
  let best: T[] = [];
  let bestGap: BigNumber | undefined;
  const consider = (subset: T[]) => {
    const basis = sumBasis(subset);
    if (basis.lte(lo) || basis.gt(hi)) return;
    const gap = stockDebtUsdg.minus(basis).abs();
    if (bestGap === undefined || gap.lt(bestGap)) {
      best = subset;
      bestGap = gap;
    }
  };
  if (candidates.length <= MAX_SUBSET_CANDIDATES) {
    for (let mask = 1; mask < 1 << candidates.length; mask++) consider(candidates.filter((_, i) => mask & (1 << i)));
  } else {
    candidates.forEach((p) => consider([p]));
  }
  return best;
}

export interface EquityPositionView {
  strategyId: string; // the vault's id ("equity-0x…")
  chainId: number;
  curator: string;
  stock: {
    symbol: string;
    collateral: string; // stock held as collateral (whole units)
    collateralUsd: string;
    priceUsd: string;
    debtUsdg: string; // USDG owed on the stock leg
    ltvPct: string;
    liquidationLtvPct: string;
    ltvHeadroomPct: string;
    liquidationPriceUsd: string; // stock price at which the leg liquidates
    priceDropToLiquidationPct: string;
    borrowApyPct: string;
  };
  /** The vault's yield loop(s) — plain Spiral positions, claimed by this vault (excluded from `positions`). */
  yieldLoops: LeveragePositionView[];
  netValueUsd: string; // (stock collateral − stock debt) + Σ yield-loop equity
  currentNetApyPct: string; // at the CURRENT stock LTV: ltv × (yieldLegApy − stockBorrowApy)
}

/** A wallet's open equity vaults on `chainId`, plus its plain loops with the vaults' yield legs removed. */
export async function getUserEquityPositions(
  chainId: number,
  user: string,
): Promise<{ equityPositions: EquityPositionView[]; positions: LeveragePositionView[] }> {
  const positions = await getUserPositions(chainId, user);
  const loops = composeSnapshot(chainId).markets.map((m) => m.market);
  const vaults = buildEquityMarkets(chainId, loops);
  if (vaults.length === 0) return { equityPositions: [], positions };

  const flashLeverageAddress = readAddresses(chainId).flashLeverageAddress as `0x${string}`;
  const client = getClient(chainId);
  const flAbi = [
    { type: "function", name: "getMorphoPosition", stateMutability: "view", inputs: [{ name: "user", type: "address" }, { name: "market", type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] }], outputs: [{ type: "tuple", components: [{ name: "supplyShares", type: "uint256" }, { name: "borrowShares", type: "uint128" }, { name: "collateral", type: "uint128" }] }] },
    { type: "function", name: "getSharesValueInLoanToken", stateMutability: "view", inputs: [{ name: "market", type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] }, { name: "borrowShares", type: "uint256" }], outputs: [{ type: "uint256" }] },
  ] as const;

  // Stock-leg Morpho position (collateral + borrowShares) under the USER (not a proxy), per vault.
  const stockPositions = (await client.multicall({
    contracts: vaults.map((m) => ({ abi: flAbi, address: flashLeverageAddress, functionName: "getMorphoPosition" as const, args: [user as `0x${string}`, stockMarketParamsTuple(m.equityVault!)] })),
    allowFailure: false,
  })) as unknown as { borrowShares: bigint; collateral: bigint }[];
  const debts = (await client.multicall({
    contracts: vaults.map((m, i) => ({ abi: flAbi, address: flashLeverageAddress, functionName: "getSharesValueInLoanToken" as const, args: [stockMarketParamsTuple(m.equityVault!), stockPositions[i]?.borrowShares ?? 0n] })),
    allowFailure: false,
  })) as unknown as bigint[];

  const equityPositions: EquityPositionView[] = [];
  const claimed = new Set<number>();
  vaults.forEach((equityMarket, i) => {
    const mp = stockPositions[i];
    if (!mp || mp.collateral <= 0n) return; // no live stock leg ⇒ this vault isn't open
    const ev = equityMarket.equityVault!;
    const stock = equityMarket.collateralToken;
    const usdg = equityMarket.loanToken;

    const collateral = formatUnits(mp.collateral, stock.decimals);
    const collateralUsd = collateral.multipliedBy(stock.valueInUsd);
    const debtUsdg = formatUnits(debts[i] ?? 0n, usdg.decimals);
    const debtUsd = debtUsdg.multipliedBy(usdg.valueInUsd);
    const ltv = collateralUsd.isZero() ? BigNumber(0) : debtUsd.div(collateralUsd).multipliedBy(100);

    const candidates = positions.filter(
      (p) => p.open && !p.liquidated && !claimed.has(p.id) && p.strategyId.toLowerCase() === ev.yieldMarketId.toLowerCase(),
    );
    const yieldLoops = matchVaultYieldLoops(candidates, debtUsdg);
    if (yieldLoops.length === 0) return; // stock leg with no matching yield loop — leave the loops in the list
    yieldLoops.forEach((p) => claimed.add(p.id));

    const loopsEquityUsd = yieldLoops.reduce((t, p) => t.plus(p.netValueUsd), BigNumber(0));
    equityPositions.push({
      strategyId: equityMarket.morphoMarketId,
      chainId,
      curator: ev.curator,
      stock: {
        symbol: stock.symbol,
        collateral: collateral.toFixed(6, BigNumber.ROUND_DOWN),
        collateralUsd: collateralUsd.toFixed(2),
        priceUsd: BigNumber(ev.stockPriceUsd).toFixed(4),
        debtUsdg: debtUsdg.toFixed(6, BigNumber.ROUND_DOWN),
        ltvPct: ltv.toFixed(2),
        liquidationLtvPct: BigNumber(ev.liqLtvPct).toFixed(2),
        ltvHeadroomPct: BigNumber(ev.liqLtvPct).minus(ltv).toFixed(2),
        liquidationPriceUsd: BigNumber(ev.stockPriceUsd).multipliedBy(ltv).div(ev.liqLtvPct).toFixed(4),
        priceDropToLiquidationPct: BigNumber(1).minus(ltv.div(ev.liqLtvPct)).multipliedBy(100).toFixed(2),
        borrowApyPct: ev.stockBorrowApyPct,
      },
      yieldLoops,
      netValueUsd: collateralUsd.minus(debtUsd).plus(loopsEquityUsd).toFixed(2),
      currentNetApyPct: ltv.div(100).multipliedBy(BigNumber(ev.yieldLegApyPct).minus(ev.stockBorrowApyPct)).toFixed(2),
    });
  });

  return { equityPositions, positions: positions.filter((p) => !claimed.has(p.id)) };
}

// ── exit ──────────────────────────────────────────────────────────────────────────────────────────
export interface BuildEquityExitInput {
  chainId: number;
  userAddress: string;
  strategyId: string; // the vault's id
  slippage?: number; // ratio, default 0.01, capped at 0.01
}

export async function buildEquityExitTx(input: BuildEquityExitInput): Promise<EquityCallBundle> {
  const { chainId, userAddress } = input;
  const { equityMarket, ev, yieldMarket, router, flashLeverageAddress } = resolveVault(chainId, input.strategyId);
  assertMarketDataFresh(chainId);
  const slippage = Math.min(input.slippage ?? EQUITY_SLIPPAGE, MAX_SLIPPAGE);
  const usdg = equityMarket.loanToken;
  const stock = equityMarket.collateralToken;
  const yieldCollateral = yieldMarket.collateralToken;

  const { equityPositions } = await getUserEquityPositions(chainId, userAddress);
  const pos = equityPositions.find((p) => p.strategyId.toLowerCase() === input.strategyId.toLowerCase());
  if (!pos) throw new Error(`No open ${stock.symbol} equity vault for ${userAddress} on chain ${chainId}`);
  const debtRaw = parseUnits(pos.stock.debtUsdg, usdg.decimals);
  if (debtRaw <= 0n) {
    // equityExit flash-loans the debt, so a debt-free stock leg cannot go through it (NoDebt revert).
    throw new Error(`The ${stock.symbol} stock leg has no debt; withdraw the collateral straight from Morpho instead.`);
  }

  const calls: Call[] = [];
  const estimated = { loopsOutUsdg: BigNumber(0) };
  // 1. Close every yield loop (owner-only ⇒ the user's own calls). Proceeds (USDG) go to the user.
  //    Each is sized on the loop's exact on-chain collateral, as the app's close is.
  for (const loop of pos.yieldLoops) {
    const live = await readManagePosition(chainId, userAddress, loop.id);
    const closeSwap = await getSwapData(
      chainId, false, flashLeverageAddress, yieldCollateral.address, usdg.address, live.collateralRaw, slippage, 0,
      oracleReferenceOut(yieldMarket, yieldCollateral.address, live.collateralRaw, usdg.address),
    );
    calls.push({
      to: flashLeverageAddress,
      data: encodeFunctionData({ abi: FLASH_LEVERAGE_DELEVERAGE_ABI, functionName: "deleverage", args: [BigInt(loop.id), 0n, closeSwap.swapData as { extRouter: `0x${string}`; extCalldata: `0x${string}` }, minOut(closeSwap.amountOut, slippage)] }),
    });
    estimated.loopsOutUsdg = estimated.loopsOutUsdg.plus(formatUnits(closeSwap.amountOut, usdg.decimals)).minus(live.amountLoan);
  }
  // 2. Authorize the router on Morpho (revoked in step 4).
  calls.push(authorizeCall(ev.morpho, router, true));
  // 3. Router unwinds the stock leg (flash-loan repay → withdraw stock → swap to USDG → to the user).
  const stockCollateralRaw = parseUnits(pos.stock.collateral, stock.decimals);
  const stockOut = await getSwapData(
    chainId, false, router, stock.address, usdg.address, stockCollateralRaw, slippage, 0,
    oracleReferenceOut(equityMarket, stock.address, stockCollateralRaw, usdg.address),
  );
  // Floor on the USDG returned: the swap's min-out less the debt (+ a small interest buffer).
  const swapFloor = minOut(stockOut.amountOut, slippage);
  const debtBuffered = parseUnits(BigNumber(pos.stock.debtUsdg).multipliedBy(EXIT_DEBT_BUFFER).toFixed(usdg.decimals, BigNumber.ROUND_UP), usdg.decimals);
  const minLoanOut = swapFloor > debtBuffered ? swapFloor - debtBuffered : 0n;
  calls.push({
    to: router,
    data: encodeFunctionData({
      abi: EQUITY_ROUTER_ABI,
      functionName: "equityExit",
      args: [{ stockMarketId: ev.stockMarketId as `0x${string}`, stockSwapData: stockOut.swapData as { extRouter: `0x${string}`; extCalldata: `0x${string}` }, minLoanOut }],
    }),
  });
  // 4. Revoke.
  calls.push(authorizeCall(ev.morpho, router, false));

  const stockOutUsdg = formatUnits(stockOut.amountOut, usdg.decimals).minus(pos.stock.debtUsdg);
  return {
    chainId,
    action: "equity_exit",
    strategyId: input.strategyId,
    calls,
    atomic: true,
    meta: {
      userAddress,
      position: pos,
      closedYieldPositionIds: pos.yieldLoops.map((l) => l.id),
      minLoanOut: minLoanOut.toString(),
      estimatedUsdgOut: stockOutUsdg.plus(estimated.loopsOutUsdg).toFixed(2),
      slippage,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signingUrl: portfolioSigningUrl(chainId, pos.yieldLoops[0]!.id),
      instructions:
        `Close the ${stock.symbol} + yield vault (unwind ${pos.yieldLoops.length} yield loop(s), then the stock leg): ` +
        `either open meta.signingUrl to review and sign in your own wallet via the Spiral app (recommended), or ${BATCH_INSTRUCTIONS} ` +
        `Non-custodial: built for ${userAddress}; that wallet must sign.`,
    },
  };
}

// ── guard for the manage builder ──────────────────────────────────────────────────────────────────
// A vault's yield loop is an ordinary loop position on chain. Managing it alone (closing it, most
// harmfully) leaves the user's stock leg standing with its USDG debt and no yield leg funding it —
// so every manage action on a claimed loop is refused and pointed at the vault exit. Cheap when the
// market is not any vault's yield market (no reads at all).
export async function assertNotVaultYieldLeg(chainId: number, user: string, id: number, market: Market): Promise<void> {
  const loops = composeSnapshot(chainId).markets.map((m) => m.market);
  const isYieldMarket = buildEquityMarkets(chainId, loops).some(
    (v) => v.equityVault!.yieldMarketId.toLowerCase() === market.morphoMarketId.toLowerCase(),
  );
  if (!isYieldMarket) return;
  const { equityPositions } = await getUserEquityPositions(chainId, user);
  const owner = equityPositions.find((p) => p.yieldLoops.some((l) => l.id === id));
  if (!owner) return;
  throw new Error(
    `Position ${id} is the yield leg of your ${owner.stock.symbol} equity vault (${owner.strategyId}). Managing it alone would ` +
      `leave the ${owner.stock.symbol} stock leg standing with its ${owner.stock.debtUsdg} USDG debt. Use build_equity_exit_tx to ` +
      `unwind the whole vault.`,
  );
}
