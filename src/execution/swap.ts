// Swap calldata — ported from v2-client api-services/{swapAggregator,metaDexAggregator}.ts
// (mainnet path only). PT collateral routes via the Pendle SDK /v3/sdk/convert with the 10 bps
// currency_in fee; everything else via KyberSwap (routes -> route/build). Fund-relevant: the fee
// routing and slippage encoding MUST match the app exactly.
//
// Returns { swapData: { extRouter, extCalldata }, amountOut, source } — the extCalldata is what the
// FlashLeverage contract executes; amountOut feeds minTokenOut + flash-loan sizing; source is the
// winning venue (KyberSwap/OpenOcean/Pendle), surfaced in the partner build meta. Price impact is NOT
// returned here: each venue reports it in its own (unreliable) convention, so callers derive it from
// the app's own token prices instead — one formula for every venue.
import { getJson, postJson } from "../sources/http.ts";
import { getMainnetClient } from "../sources/onchain.ts";
import { captureError } from "../config/sentry.ts";
import { env } from "../config/env.ts";

const KYBERSWAP_URL = "https://aggregator-api.kyberswap.com";
const OPENOCEAN_URL = "https://open-api-pro.openocean.finance";
const PENDLE_SWAP_URL = "https://api-v2.pendle.finance/core";
const ROBINHOOD_CHAIN_ID = 4663;
// KyberSwap chain slug, mirroring the app's chainConfig[chainId].name.toLowerCase().
const KYBER_CHAIN_NAME: Record<number, string> = { 1: "ethereum", [ROBINHOOD_CHAIN_ID]: "robinhood" };
// OpenOcean path chain code — mainnet only (it doesn't support Robinhood).
const OPENOCEAN_CHAIN_CODE: Record<number, string> = { 1: "eth" };
// OpenOcean Exchange V2 router: the tx target ('to') and the address that MUST be whitelisted on-chain
// via FlashLeverage.setSwapRouter. Constant across chains. Any other 'to' is rejected before returning.
const OPENOCEAN_ROUTER = "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64";
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_KYBER = "0x" + "e".repeat(40); // KyberSwap/OpenOcean native-token placeholder (0xeee…eee)

export interface SwapData {
  extRouter: string;
  extCalldata: string;
}
// Which venue produced the quote we're executing — mirrors the app's SwapQuote.source, surfaced in
// the partner build `meta` so an integrator/agent can see which aggregator won the race.
export type SwapSource = "KyberSwap" | "OpenOcean" | "Pendle";
export interface SwapResult {
  swapData: SwapData;
  amountOut: bigint;
  source: SwapSource;
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
  // Expected tokenOut (raw), from the caller's trusted reference (the collateral<->loan oracle rate).
  // Used ONLY to sanity-check an OpenOcean-only quote (KyberSwap down) — see MAX_OO_ONLY_DEVIATION_BPS.
  referenceOut?: bigint,
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
        routes: { chargeFeeBy: "currency_in", feeAmount: "5", feeReceiver, isInBps: true },
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
      source: "Pendle",
    };
  }

  // Aggregator path (mainnet + Robinhood). Mirror the app's chain guard: hardhat fork → mainnet.
  if (chainId === 1 || chainId === 31337) chainId = 1;
  else if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`No swap aggregator configured for chainId ${chainId}`);

  const fee = chargeFee ? feeReceiver : undefined;

  // Mainnet: race KyberSwap + OpenOcean and take the better amountOut for the user. Gated on the
  // OpenOcean key being configured (its router must be whitelisted on-chain first) AND the
  // OPENOCEAN_ENABLED kill switch; either off → KyberSwap only. Robinhood stays KyberSwap-only
  // (OpenOcean doesn't support it).
  if (chainId === 1 && env.OPENOCEAN_API_KEY && env.OPENOCEAN_ENABLED) {
    return pickBestSwap(chainId, receiver, tokenIn, tokenOut, amountIn, slippage, fee, referenceOut);
  }
  return callKyberswap(chainId, receiver, tokenIn, tokenOut, amountIn, slippage, fee);
}

// KyberSwap is the baseline aggregator; OpenOcean is the challenger, taken only when it wins by a
// plausible margin. A real cross-aggregator edge above ~1% doesn't occur, so a larger "advantage"
// means OpenOcean is quoting output it cannot fill (measured live: intermittently inflated, or as low
// as ~0.25% of the correct amount) — trusting it would size minTokenOut/flash-loan on undeliverable
// output and the tx reverts (FlashLeverage__MinTokenOutNotMet). The asymmetry is deliberate: a
// symmetric "discard whichever quote is further ahead" rule would throw away KyberSwap's correct quote
// when OpenOcean returns a wildly LOW one (which makes the correct one look implausibly far ahead).
const MAX_QUOTE_ADVANTAGE_BPS = 100n;
// OpenOcean-only (KyberSwap down): no baseline to bound against, so we validate against the caller's
// trusted reference (the collateral<->loan oracle rate). 10% comfortably clears fee + slippage +
// realistic price impact, and catches catastrophic misquotes (measured live: OpenOcean returned ~2%
// of the correct strUSD amount). Beyond this, fail the swap rather than sign a ruinous fill.
const MAX_OO_ONLY_DEVIATION_BPS = 1000n;

// Race both aggregators; take OpenOcean only when it beats KyberSwap by <= MAX_QUOTE_ADVANTAGE_BPS. If
// only one succeeds, use it (OpenOcean-only is validated against `referenceOut`); if both fail,
// surface the KyberSwap error since it's the baseline.
async function pickBestSwap(
  chainId: number,
  receiver: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint | string,
  slippage: number,
  feeReceiver?: string,
  referenceOut?: bigint,
): Promise<SwapResult> {
  const [kyber, oo] = await Promise.allSettled([
    callKyberswap(chainId, receiver, tokenIn, tokenOut, amountIn, slippage, feeReceiver),
    callOpenOcean(chainId, receiver, tokenIn, tokenOut, amountIn, slippage, feeReceiver),
  ]);

  // A losing venue is indistinguishable from a broken one — an expired key, a 401 or a timeout just
  // looks like "the other aggregator won". Report each failure so a venue that has silently stopped
  // answering is visible rather than inferred from a missing name. Reporting only; the survivor is used.
  const ctx = { chainId, tokenIn, tokenOut, amountIn: String(amountIn) };
  if (kyber.status === "rejected") captureError(kyber.reason, { ...ctx, venue: "KyberSwap" });
  if (oo.status === "rejected") captureError(oo.reason, { ...ctx, venue: "OpenOcean" });

  const kyberQuote = kyber.status === "fulfilled" ? kyber.value : null;
  const ooQuote = oo.status === "fulfilled" ? oo.value : null;
  if (!kyberQuote && !ooQuote) {
    throw kyber.status === "rejected" ? kyber.reason : (oo as PromiseRejectedResult).reason;
  }
  if (!ooQuote) return kyberQuote!;
  if (!kyberQuote || kyberQuote.amountOut <= 0n) {
    // OpenOcean-only — no KyberSwap baseline. Validate against the caller's reference; a quote deviating
    // beyond the bound is unfillable/mispriced, so throw (the swap fails and the caller retries) rather
    // than return a catastrophic fill. No reference (unknown pair) → accept, matching prior behaviour.
    if (referenceOut !== undefined && referenceOut > 0n) {
      const diff = ooQuote.amountOut > referenceOut ? ooQuote.amountOut - referenceOut : referenceOut - ooQuote.amountOut;
      if (diff * 10_000n > referenceOut * MAX_OO_ONLY_DEVIATION_BPS) {
        captureError(
          new Error(`OpenOcean-only quote failed the plausibility guard (>${MAX_OO_ONLY_DEVIATION_BPS} bps from reference)`),
          { ...ctx, openOceanAmountOut: String(ooQuote.amountOut), referenceOut: String(referenceOut) },
        );
        throw kyber.status === "rejected" ? kyber.reason : new Error("OpenOcean-only quote rejected (no plausible route)");
      }
    }
    return ooQuote;
  }
  if (ooQuote.amountOut <= kyberQuote.amountOut) return kyberQuote;

  // OpenOcean wins — accept only within the plausibility bound, else discard it as unfillable.
  const limit = (kyberQuote.amountOut * (10_000n + MAX_QUOTE_ADVANTAGE_BPS)) / 10_000n;
  if (ooQuote.amountOut > limit) {
    captureError(
      new Error(`Implausible OpenOcean quote discarded (over ${MAX_QUOTE_ADVANTAGE_BPS} bps above KyberSwap)`),
      { ...ctx, openOceanAmountOut: String(ooQuote.amountOut), kyberSwapAmountOut: String(kyberQuote.amountOut) },
    );
    return kyberQuote;
  }
  return ooQuote;
}

async function callOpenOcean(
  chainId: number,
  receiver: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint | string,
  slippage: number,
  feeReceiver?: string,
): Promise<SwapResult> {
  const chainCode = OPENOCEAN_CHAIN_CODE[chainId];
  if (!chainCode) throw new Error(`OpenOcean unsupported for chainId ${chainId}`);
  if (tokenIn === NATIVE_ADDRESS) tokenIn = NATIVE_KYBER;
  if (tokenOut === NATIVE_ADDRESS) tokenOut = NATIVE_KYBER;

  // gasPriceDecimals is REQUIRED and expressed in wei (viem's getGasPrice returns wei).
  const gasPrice = await getMainnetClient().getGasPrice();

  const q = new URLSearchParams({
    inTokenAddress: tokenIn,
    outTokenAddress: tokenOut,
    amountDecimals: String(amountIn), // wei — the same amount we pass KyberSwap
    gasPriceDecimals: String(gasPrice), // wei
    slippage: String(slippage * 100), // ratio → percent (0.01 → 1)
    account: receiver, // output lands in the executing contract
  });
  if (feeReceiver) {
    q.set("referrer", feeReceiver);
    // 0.0625% = 6.25 bps on the input token. OpenOcean keeps 20% of the referral fee, so 6.25 bps
    // nets the protocol exactly 5 bps (6.25 × 0.80) — the same take as the 5 bps KyberSwap charges.
    q.set("referrerFee", "0.0625");
  }

  const res = await getJson<{ data?: OpenOceanSwap }>(`${OPENOCEAN_URL}/v4/${chainCode}/swap?${q}`, {
    source: "openocean-swap",
    headers: { apikey: env.OPENOCEAN_API_KEY! },
    retries: 1,
    // Bounded tighter than other upstreams: pickBestSwap awaits BOTH venues, so an unresponsive
    // OpenOcean would otherwise stall every quote behind it (mirrors the app's 8s bound).
    timeoutMs: 8_000,
  });
  const d = res?.data;
  if (!d?.to || !d?.data || d.outAmount == null) throw new Error("OpenOcean swap returned no calldata");
  // The contract only executes whitelisted routers — never hand back calldata for an unexpected target.
  if (d.to.toLowerCase() !== OPENOCEAN_ROUTER.toLowerCase()) {
    throw new Error(`OpenOcean returned non-whitelisted router ${d.to}`);
  }
  return {
    swapData: { extRouter: d.to, extCalldata: d.data },
    amountOut: BigInt(d.outAmount),
    source: "OpenOcean",
  };
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
    q.set("feeAmount", "5"); // 5 bps = 0.05% (KyberSwap takes no cut → protocol nets 5 bps)
  }
  const routes = await getJson<KyberRoutes>(`${KYBERSWAP_URL}/${chainName}/api/v1/routes?${q}`, {
    source: "kyberswap-routes",
    retries: 1,
    timeoutMs: 20_000,
  });
  // The build endpoint wants the inner route object (routeSummary + route) at the TOP level — the
  // app destructures `body.data` before spreading it, so we spread routes.data, not the envelope.
  const routeData = routes?.data;

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
    source: "KyberSwap",
  };
}

interface PendleRoute {
  tx?: { to?: string; data?: string };
  outputs?: { amount?: string }[];
}
interface KyberRoutes {
  data?: { [k: string]: unknown };
}
interface KyberBuilt {
  routerAddress?: string;
  data?: string;
  amountOut?: string;
}
interface OpenOceanSwap {
  to?: string;
  data?: string;
  outAmount?: string;
}
