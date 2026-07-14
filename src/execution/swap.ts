// Swap calldata — ported from v2-client api-services/{swapAggregator,metaDexAggregator}.ts
// (mainnet path only). PT collateral routes via the Pendle SDK /v3/sdk/convert with the 10 bps
// currency_in fee; everything else via KyberSwap (routes -> route/build). Fund-relevant: the fee
// routing and slippage encoding MUST match the app exactly.
//
// Returns { swapData: { extRouter, extCalldata }, amountOut, priceImpact? } — the extCalldata is what
// the FlashLeverage contract executes; amountOut feeds minTokenOut + flash-loan sizing.
import { getJson, postJson } from "../sources/http.ts";
import { env } from "../config/env.ts";

const KYBERSWAP_URL = "https://aggregator-api.kyberswap.com";
const PENDLE_SWAP_URL = "https://api-v2.pendle.finance/core";
const ROBINHOOD_CHAIN_ID = 4663;
// KyberSwap chain slug, mirroring the app's chainConfig[chainId].name.toLowerCase().
const KYBER_CHAIN_NAME: Record<number, string> = { 1: "ethereum", [ROBINHOOD_CHAIN_ID]: "robinhood" };
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_KYBER = "0x" + "e".repeat(40); // KyberSwap's native-token placeholder (0xeee…eee)

export interface SwapData {
  extRouter: string;
  extCalldata: string;
}
export interface SwapResult {
  swapData: SwapData;
  amountOut: bigint;
  priceImpact?: number;
}

// isPt = collateral is a Pendle PT (route via Pendle SDK). receiver = the contract that executes the
// calldata (FlashLeverage or the Router). chargeFee toggles the 10 bps fee (default on, as the app).
// chainId selects the aggregator chain (1 = mainnet, 4663 = Robinhood; 31337 hardhat fork → 1).
export async function getSwapData(
  chainId: number,
  isPt: boolean,
  receiver: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint | string,
  slippage: number,
  chargeFee = true,
): Promise<SwapResult> {
  const feeReceiver = env.FEE_RECEIVER;

  if (isPt) {
    const body: Record<string, unknown> = {
      receiver,
      slippage,
      enableAggregator: true,
      aggregators: ["kyberswap"],
      inputs: [{ token: tokenIn, amount: String(amountIn) }],
      outputs: [tokenOut],
    };
    if (chargeFee && feeReceiver) {
      body.kyberSwapParams = {
        routes: { chargeFeeBy: "currency_in", feeAmount: "10", feeReceiver, isInBps: true },
      };
    }
    const res = await postJson<{ routes?: PendleRoute[] }>(
      `${PENDLE_SWAP_URL}/v3/sdk/${chainId}/convert`,
      body,
      { source: "pendle-swap", retries: 1, timeoutMs: 20_000 },
    );
    const route = res?.routes?.[0];
    if (!route?.tx?.to || !route?.tx?.data || route.outputs?.[0]?.amount == null) {
      throw new Error("Pendle convert returned no route");
    }
    return {
      swapData: { extRouter: route.tx.to, extCalldata: route.tx.data },
      amountOut: BigInt(route.outputs[0].amount),
    };
  }

  // KyberSwap (mainnet + Robinhood). Mirror the app's chain guard: hardhat fork → mainnet.
  if (chainId === 1 || chainId === 31337) chainId = 1;
  else if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`No swap aggregator configured for chainId ${chainId}`);

  return callKyberswap(chainId, receiver, tokenIn, tokenOut, amountIn, slippage, chargeFee ? feeReceiver : undefined);
}

async function callKyberswap(
  chainId: number,
  receiver: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint | string,
  slippage: number,
  feeReceiver?: string,
): Promise<SwapResult> {
  const chainName = KYBER_CHAIN_NAME[chainId];
  if (tokenIn === NATIVE_ADDRESS) tokenIn = NATIVE_KYBER;

  const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: String(amountIn) });
  if (feeReceiver) {
    q.set("isInBps", "true");
    q.set("chargeFeeBy", "currency_in");
    q.set("feeReceiver", feeReceiver);
    q.set("feeAmount", "10"); // 10 bps = 0.1%
  }
  const routes = await getJson<KyberRoutes>(`${KYBERSWAP_URL}/${chainName}/api/v1/routes?${q}`, {
    source: "kyberswap-routes",
    retries: 1,
    timeoutMs: 20_000,
  });
  // The build endpoint wants the inner route object (routeSummary + route) at the TOP level — the
  // app destructures `body.data` before spreading it, so we spread routes.data, not the envelope.
  const routeData = routes?.data;
  const rs = routeData?.routeSummary;
  const inUsd = Number(rs?.amountInUsd);
  const outUsd = Number(rs?.amountOutUsd);
  const priceImpact = inUsd && outUsd ? ((inUsd - outUsd) / inUsd) * 100 : undefined;

  // slippage is a ratio (0.01 = 1%); KyberSwap wants bps-of-bps (× 10000): 0.01 → 100.
  const built = await postJson<{ data?: KyberBuilt }>(
    `${KYBERSWAP_URL}/${chainName}/api/v1/route/build`,
    { ...routeData, sender: receiver, recipient: receiver, slippageTolerance: slippage * 10000 },
    { source: "kyberswap-build", retries: 1, timeoutMs: 20_000 },
  );
  const res = built?.data;
  if (!res?.routerAddress || !res?.data || res.amountOut == null) {
    throw new Error("KyberSwap route/build returned no calldata");
  }
  return {
    swapData: { extRouter: res.routerAddress, extCalldata: res.data },
    amountOut: BigInt(res.amountOut),
    priceImpact,
  };
}

interface PendleRoute {
  tx?: { to?: string; data?: string };
  outputs?: { amount?: string }[];
}
interface KyberRoutes {
  data?: {
    routeSummary?: { amountInUsd?: string; amountOutUsd?: string };
    [k: string]: unknown;
  };
}
interface KyberBuilt {
  routerAddress?: string;
  data?: string;
  amountOut?: string;
}
