// On-chain reads via viem (replacing the app's wagmi actions). Three reads:
//   1. stUSDS APY  — str()  (per-second RAY rate) on mainnet
//   2. spUSDG APY  — vsr()  (per-second RAY rate) on Robinhood Chain (4663)
//   3. collateralTokenValueInLoanToken — FlashLeverage.getCollateralValueInLoanToken(params, 1 unit)
//      batched via multicall3, matching FlashLeverage.createInstance's per-market oracle read.
//
// Parse math is copied from api-services/apy.ts (rayRateToApy) and FlashLeverage.ts for parity.
import BigNumber from "bignumber.js";
import {
  createPublicClient,
  http,
  defineChain,
  parseUnits,
  formatUnits as viemFormatUnits,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { env } from "../config/env.ts";
import { Market } from "../types/index.ts";
import { readAddresses } from "../data/markets.ts";

const STUSDS_ADDRESS = "0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9";
const SPUSDG_ADDRESS = "0xde770c84FE66E063336b31737cFE9790f18c4087";
const ROBINHOOD_CHAIN_ID = 4663;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const stUSDSAbi = [
  { name: "str", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const spUSDGAbi = [
  { name: "vsr", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// Minimal FlashLeverage ABI — only the read the composition needs.
const flashLeverageAbi = [
  {
    type: "function",
    name: "getCollateralValueInLoanToken",
    stateMutability: "view",
    inputs: [
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "amountCollateral", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

let mainnetClient: PublicClient | undefined;
function getMainnetClient(): PublicClient {
  if (!env.MAINNET_RPC_URL) throw new Error("MAINNET_RPC_URL is not configured");
  if (!mainnetClient) {
    mainnetClient = createPublicClient({
      chain: mainnet,
      transport: http(env.MAINNET_RPC_URL),
      batch: { multicall: true },
    });
  }
  return mainnetClient;
}

let robinhoodClient: PublicClient | undefined;
function getRobinhoodClient(): PublicClient | undefined {
  if (!env.ROBINHOOD_RPC_URL) return undefined;
  if (!robinhoodClient) {
    const robinhood = defineChain({
      id: ROBINHOOD_CHAIN_ID,
      name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [env.ROBINHOOD_RPC_URL] } },
    });
    robinhoodClient = createPublicClient({ chain: robinhood, transport: http(env.ROBINHOOD_RPC_URL) });
  }
  return robinhoodClient;
}

// RAY (1e27) per-second compounding rate -> annualized APY percentage. (copied from apy.ts)
const rayRateToApy = (rate: bigint): string => {
  const perSecond = Number(rate) / 1e27;
  return BigNumber((Math.pow(perSecond, SECONDS_PER_YEAR) - 1) * 100).toFixed(2);
};

export const isStUSDS = (address: string) => address.toLowerCase() === STUSDS_ADDRESS.toLowerCase();
export const isSpUSDG = (address: string) => address.toLowerCase() === SPUSDG_ADDRESS.toLowerCase();

export async function fetchStUSDApy(): Promise<string> {
  const rate = (await getMainnetClient().readContract({
    abi: stUSDSAbi,
    address: STUSDS_ADDRESS as `0x${string}`,
    functionName: "str",
  })) as bigint;
  return rayRateToApy(rate);
}

export async function fetchSpUSDGApy(): Promise<string> {
  const client = getRobinhoodClient();
  if (!client) throw new Error("ROBINHOOD_RPC_URL is not configured");
  const rate = (await client.readContract({
    abi: spUSDGAbi,
    address: SPUSDG_ADDRESS as `0x${string}`,
    functionName: "vsr",
  })) as bigint;
  return rayRateToApy(rate);
}

// Reads getCollateralValueInLoanToken(params, 1 collateral unit) for every market via multicall,
// returning marketId → collateralTokenValueInLoanToken (BigNumber, loan-token units). Markets
// whose oracle read reverts are omitted (the composition drops them, matching the app).
export async function fetchAllCollateralValuesInLoanToken(
  chainId: number,
  markets: Market[],
): Promise<Record<string, BigNumber>> {
  if (chainId === 31337) chainId = 1;
  const flashLeverageAddress = readAddresses(chainId).flashLeverageAddress as string;
  const client = getMainnetClient();

  const contracts = markets.map((market) => ({
    address: flashLeverageAddress as `0x${string}`,
    abi: flashLeverageAbi,
    functionName: "getCollateralValueInLoanToken" as const,
    args: [
      {
        loanToken: market.loanToken.address as `0x${string}`,
        collateralToken: market.collateralToken.address as `0x${string}`,
        oracle: market.oracle as `0x${string}`,
        irm: market.irm as `0x${string}`,
        // App passes liqLtv as lltv (may be lossy from JSON number — matched intentionally).
        lltv: BigInt(market.liqLtv as unknown as number),
      },
      parseUnits("1", market.collateralToken.decimals),
    ],
  }));

  const results = await client.multicall({ contracts, allowFailure: true });

  const out: Record<string, BigNumber> = {};
  results.forEach((res, i) => {
    const market = markets[i];
    if (res.status !== "success") return; // oracle/RPC failure — drop this market (app parity)
    const valueInLoanToken = res.result as bigint;
    out[market.morphoMarketId] = new BigNumber(
      viemFormatUnits(valueInLoanToken, market.loanToken.decimals),
    );
  });
  return out;
}
