// Protocol TVL — on-chain discovery + valuation of every open Spiral position on one chain.
// Port of listings/defillama/projects/spiral-stake/index.js onto the repo's own pieces:
//
//   1. Users. Every UserProxy is a `Clones.clone` (plain CREATE) from FlashLeverage, so proxy_n =
//      keccak(rlp(FlashLeverage, n)) for n = 1 .. eth_getTransactionCount(FlashLeverage) − 1
//      (nonce 1 is the implementation, initialised with FlashLeverage itself as its user). Reading
//      `s_user()` on each gives the complete user set with two RPC round-trips and NO log scan —
//      the DefiLlama adapter's LeveragePositionOpened scan needs an unbounded eth_getLogs range,
//      which the configured Alchemy tier caps at 10 blocks (and Robinhood is ~60M blocks deep).
//      Resolved proxies are cached in memory per chain, so a refresh only derives NEW nonces.
//   2. getUserLeveragePositions(user) → open positions with a live UserProxy.
//   3. Market params from the configured markets, else morpho.idToMarketParams(marketId) — so
//      delisted markets (and equity-vault stock markets) still count.
//   4. getMorphoPosition(userProxy, params) → collateral + borrowShares;
//      getSharesValueInLoanToken(params, borrowShares) → debt in loan-token units.
//   5. Collateral → loan units via the warmed onchainCollateralValue (configured markets), else
//      the market oracle's price() (Morpho 1e36 scale). Loan → USD via the warmed prices, default
//      $1, sanity-clamped (core/tvl.ts).
//
// Reads are behind a small `TvlReads` interface so the aggregation runs offline in tests.
import BigNumber from "bignumber.js";
import { getContractAddress, type Abi } from "viem";
import flashLeverageJson from "../abi/FlashLeverage.sol/FlashLeverage.json" with { type: "json" };
import morphoJson from "../abi/IMorpho.sol/IMorpho.json" with { type: "json" };
import { log } from "../config/logger.ts";
import { rawStore, type RawStore } from "../cache/store.ts";
import { KEYS } from "../cache/policy.ts";
import { formatUnits } from "../core/formatUnits.ts";
import { clampLoanPrice, collateralValueViaOracle, sumChainTvl, type ChainTvl, type ValuedPosition } from "../core/tvl.ts";
import { readAddresses, readMarkets, registries } from "../data/markets.ts";
import { getClient } from "./onchain.ts";
import type { MarketParams } from "../types/index.ts";

const FLASH_LEVERAGE_ABI = (flashLeverageJson as { abi: Abi }).abi;
const MORPHO_ABI = (morphoJson as { abi: Abi }).abi;

const userProxyAbi = [
  { type: "function", name: "s_user", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const oracleAbi = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const erc20DecimalsAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Loan tokens whose USD price legitimately lives outside the stablecoin sanity band, keyed by the
// registry's coingeckoId. The clamp in core/tvl.ts must not coerce these to $1.
const VOLATILE_LOAN_COINGECKO_IDS = new Set(["ethereum", "wrapped-bitcoin", "coinbase-wrapped-btc", "metronome-synth-eth"]);
const volatileLoanTokens = new Set(
  registries.loanTokens
    .filter((t) => t.coingeckoId && VOLATILE_LOAN_COINGECKO_IDS.has(t.coingeckoId))
    .map((t) => t.address.toLowerCase()),
);

/** Address of the contract FlashLeverage created with its nonce `n` (CREATE, not CREATE2). */
export function deriveProxyAddress(flashLeverage: string, nonce: number): string {
  return getContractAddress({ from: flashLeverage as `0x${string}`, nonce: BigInt(nonce) });
}

export interface RawLeveragePosition {
  open: boolean;
  marketId: string;
  userProxy: string;
  amountDepositedInLoanToken: bigint;
  amountReturnedInLoanToken: bigint;
}

export interface TvlReads {
  /** eth_getTransactionCount(FlashLeverage) — one more than the last nonce it created a contract with. */
  proxyCount(): Promise<number>;
  /** UserProxy.s_user() per derived proxy address; undefined where the read reverted (not a proxy). */
  proxyUsers(proxies: string[]): Promise<(string | undefined)[]>;
  userPositions(users: string[]): Promise<RawLeveragePosition[][]>;
  idToMarketParams(marketIds: string[]): Promise<MarketParams[]>;
  morphoPositions(calls: { userProxy: string; params: MarketParams }[]): Promise<{ borrowShares: bigint; collateral: bigint }[]>;
  sharesValueInLoanToken(calls: { params: MarketParams; borrowShares: bigint }[]): Promise<bigint[]>;
  /** Morpho oracle price() per oracle address; undefined where the read reverted. */
  oraclePrices(oracles: string[]): Promise<(bigint | undefined)[]>;
  tokenDecimals(tokens: string[]): Promise<number[]>;
}

export function viemTvlReads(chainId: number): TvlReads {
  const client = getClient(chainId);
  const addresses = readAddresses(chainId);
  const flashLeverageAddress = addresses.flashLeverageAddress as `0x${string}`;
  const morphoAddress = addresses.morphoAddress as `0x${string}`;
  return {
    proxyCount: () => client.getTransactionCount({ address: flashLeverageAddress }),
    proxyUsers: async (proxies) => {
      if (proxies.length === 0) return [];
      const res = await client.multicall({
        contracts: proxies.map((proxy) => ({ abi: userProxyAbi, address: proxy as `0x${string}`, functionName: "s_user" as const })),
        allowFailure: true,
      });
      return res.map((r) => (r.status === "success" ? String(r.result) : undefined));
    },
    userPositions: async (users) =>
      users.length === 0
        ? []
        : ((await client.multicall({
            contracts: users.map((user) => ({
              abi: FLASH_LEVERAGE_ABI,
              address: flashLeverageAddress,
              functionName: "getUserLeveragePositions",
              args: [user],
            })),
            allowFailure: false,
          })) as unknown as RawLeveragePosition[][]),
    idToMarketParams: async (ids) =>
      ids.length === 0
        ? []
        : ((await client.multicall({
            contracts: ids.map((id) => ({ abi: MORPHO_ABI, address: morphoAddress, functionName: "idToMarketParams", args: [id] })),
            allowFailure: false,
          })) as unknown as MarketParams[]),
    morphoPositions: async (calls) =>
      calls.length === 0
        ? []
        : ((await client.multicall({
            contracts: calls.map((c) => ({
              abi: FLASH_LEVERAGE_ABI,
              address: flashLeverageAddress,
              functionName: "getMorphoPosition",
              args: [c.userProxy, c.params],
            })),
            allowFailure: false,
          })) as unknown as { borrowShares: bigint; collateral: bigint }[]),
    sharesValueInLoanToken: async (calls) =>
      calls.length === 0
        ? []
        : ((await client.multicall({
            contracts: calls.map((c) => ({
              abi: FLASH_LEVERAGE_ABI,
              address: flashLeverageAddress,
              functionName: "getSharesValueInLoanToken",
              args: [c.params, c.borrowShares],
            })),
            allowFailure: false,
          })) as unknown as bigint[]),
    oraclePrices: async (oracles) => {
      if (oracles.length === 0) return [];
      const res = await client.multicall({
        contracts: oracles.map((oracle) => ({ abi: oracleAbi, address: oracle as `0x${string}`, functionName: "price" as const })),
        allowFailure: true,
      });
      return res.map((r) => (r.status === "success" ? (r.result as bigint) : undefined));
    },
    tokenDecimals: async (tokens) =>
      tokens.length === 0
        ? []
        : (
            (await client.multicall({
              contracts: tokens.map((token) => ({ abi: erc20DecimalsAbi, address: token as `0x${string}`, functionName: "decimals" as const })),
              allowFailure: false,
            })) as unknown as (number | bigint)[]
          ).map(Number),
  };
}

// ── User discovery cache (per chain, per process) ──
interface DiscoveryState {
  users: Set<string>; // lowercase
  nextNonce: number; // first FlashLeverage nonce not yet resolved
}
const discovery = new Map<number, DiscoveryState>();
const decimalsCache = new Map<string, number>(); // `${chainId}:${token}` → decimals

/** Test hook — forget discovered users / cached decimals. */
export function __resetTvlScanCache(): void {
  discovery.clear();
  decimalsCache.clear();
}

async function discoverUsers(chainId: number, reads: TvlReads): Promise<Set<string>> {
  const flashLeverage = (readAddresses(chainId).flashLeverageAddress as string).toLowerCase();
  let state = discovery.get(chainId);
  if (!state) {
    // Nonce 1 is the UserProxy implementation (its s_user is FlashLeverage itself) — skip it.
    state = { users: new Set(), nextNonce: 2 };
    discovery.set(chainId, state);
  }
  const count = await reads.proxyCount();
  if (count <= state.nextNonce) return state.users;

  const nonces = Array.from({ length: count - state.nextNonce }, (_, i) => state!.nextNonce + i);
  const proxies = nonces.map((n) => deriveProxyAddress(flashLeverage, n));
  const users = await reads.proxyUsers(proxies);
  users.forEach((user, i) => {
    const u = user?.toLowerCase();
    if (!u || u === ZERO_ADDRESS || u === flashLeverage) {
      log.warn("tvl: derived address is not a user proxy — skipped", { chainId, nonce: nonces[i], proxy: proxies[i] });
      return;
    }
    state!.users.add(u);
  });
  state.nextNonce = count;
  return state.users;
}

async function resolveDecimals(chainId: number, tokens: string[], reads: TvlReads): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: string[] = [];
  for (const t of tokens) {
    const cached = decimalsCache.get(`${chainId}:${t.toLowerCase()}`);
    if (cached !== undefined) out.set(t.toLowerCase(), cached);
    else missing.push(t);
  }
  if (missing.length) {
    const decs = await reads.tokenDecimals(missing);
    missing.forEach((t, i) => {
      decimalsCache.set(`${chainId}:${t.toLowerCase()}`, decs[i]);
      out.set(t.toLowerCase(), decs[i]);
    });
  }
  return out;
}

export async function fetchChainTvl(chainId: number, reads: TvlReads = viemTvlReads(chainId), store: RawStore = rawStore): Promise<ChainTvl> {
  const users = [...(await discoverUsers(chainId, reads))];
  if (users.length === 0) return sumChainTvl(chainId, []);

  // 2. Open positions with a live proxy.
  const lists = await reads.userPositions(users);
  const open = lists.flatMap((list, i) =>
    (list ?? [])
      .filter((p) => p.open && p.userProxy.toLowerCase() !== ZERO_ADDRESS)
      .map((p) => ({ user: users[i], marketId: p.marketId.toLowerCase(), userProxy: p.userProxy })),
  );
  if (open.length === 0) return sumChainTvl(chainId, []);

  // 3. Market params — configured first, Morpho registry for the rest.
  const configured = new Map(readMarkets(chainId).map((m) => [m.morphoMarketId.toLowerCase(), m]));
  const paramsById = new Map<string, MarketParams>();
  const unknownIds: string[] = [];
  for (const id of new Set(open.map((p) => p.marketId))) {
    const m = configured.get(id);
    if (m) {
      paramsById.set(id, {
        loanToken: m.loanToken.address,
        collateralToken: m.collateralToken.address,
        oracle: m.oracle,
        irm: m.irm,
        lltv: BigInt(m.liqLtv as unknown as number),
      });
    } else unknownIds.push(id);
  }
  if (unknownIds.length) {
    const fetched = await reads.idToMarketParams(unknownIds);
    unknownIds.forEach((id, i) => {
      const p = fetched[i];
      if (p && p.loanToken.toLowerCase() !== ZERO_ADDRESS) paramsById.set(id, { ...p, lltv: BigInt(p.lltv) });
      else log.warn("tvl: unknown market id (no Morpho params)", { chainId, marketId: id });
    });
  }
  const priced = open.filter((p) => paramsById.has(p.marketId));

  // 4. Collateral + debt.
  const morphoPositions = await reads.morphoPositions(priced.map((p) => ({ userProxy: p.userProxy, params: paramsById.get(p.marketId)! })));
  const live = priced
    .map((p, i) => ({ ...p, collateral: morphoPositions[i]?.collateral ?? 0n, borrowShares: morphoPositions[i]?.borrowShares ?? 0n }))
    .filter((p) => p.collateral > 0n); // liquidated (zero-collateral) positions contribute nothing
  if (live.length === 0) return sumChainTvl(chainId, []);
  const debts = await reads.sharesValueInLoanToken(live.map((p) => ({ params: paramsById.get(p.marketId)!, borrowShares: p.borrowShares })));

  // 5. Valuation inputs: warmed collateral values (configured markets), oracle price() for the
  //    rest, ERC20 decimals for unconfigured loan tokens, warmed USD prices for loan tokens.
  const collateralValues = store.view<Record<string, BigNumber>>(KEYS.onchainCollateralValue(chainId))?.value ?? {};
  const collateralValueById = new Map(Object.entries(collateralValues).map(([id, v]) => [id.toLowerCase(), v]));
  const pricesRaw = store.view<Record<string, BigNumber | number | string>>(KEYS.prices(chainId))?.value ?? {};
  const priceByToken = new Map(Object.entries(pricesRaw).map(([addr, v]) => [addr.toLowerCase(), v]));

  const needsOracle = [...new Set(live.filter((p) => !collateralValueById.has(p.marketId)).map((p) => p.marketId))];
  const oraclePrices = new Map<string, bigint | undefined>();
  if (needsOracle.length) {
    const prices = await reads.oraclePrices(needsOracle.map((id) => paramsById.get(id)!.oracle));
    needsOracle.forEach((id, i) => oraclePrices.set(id, prices[i]));
  }
  const loanDecimals = new Map<string, number>();
  const unknownLoanTokens: string[] = [];
  for (const id of needsOracle) {
    const m = configured.get(id);
    const loanToken = paramsById.get(id)!.loanToken.toLowerCase();
    if (m) loanDecimals.set(loanToken, m.loanToken.decimals);
    else if (!loanDecimals.has(loanToken)) unknownLoanTokens.push(loanToken);
  }
  for (const [token, dec] of await resolveDecimals(chainId, [...new Set(unknownLoanTokens)], reads)) loanDecimals.set(token, dec);

  // 6. Value each position in loan units, then USD.
  const valued: ValuedPosition[] = [];
  live.forEach((p, i) => {
    const params = paramsById.get(p.marketId)!;
    const m = configured.get(p.marketId);
    const loanToken = params.loanToken.toLowerCase();

    let collateralValueInLoan: BigNumber;
    let debtDecimals: number;
    const warmed = collateralValueById.get(p.marketId);
    if (m && warmed !== undefined) {
      const perUnit = warmed instanceof BigNumber ? warmed : new BigNumber(warmed as unknown as string);
      collateralValueInLoan = formatUnits(p.collateral, m.collateralToken.decimals).multipliedBy(perUnit);
      debtDecimals = m.loanToken.decimals;
    } else {
      const price = oraclePrices.get(p.marketId);
      const dec = loanDecimals.get(loanToken);
      if (price === undefined || dec === undefined) {
        log.warn("tvl: position skipped (no oracle price / decimals)", { chainId, marketId: p.marketId, userProxy: p.userProxy });
        return;
      }
      collateralValueInLoan = collateralValueViaOracle(p.collateral, price, dec);
      debtDecimals = dec;
    }

    const rawPrice = priceByToken.get(loanToken);
    const loanPriceUsd = clampLoanPrice(
      rawPrice instanceof BigNumber ? rawPrice : rawPrice != null ? new BigNumber(rawPrice as string) : undefined,
      volatileLoanTokens.has(loanToken),
    );
    valued.push({
      user: p.user,
      collateralValueInLoan,
      debtInLoan: formatUnits(debts[i] ?? 0n, debtDecimals),
      loanPriceUsd,
    });
  });

  return sumChainTvl(chainId, valued);
}
