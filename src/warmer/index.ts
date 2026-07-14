// Background warmer — the only thing that talks to upstreams on a schedule. It keeps the RAW
// cache warm (stale-while-revalidate) on the CONTRACT.md cadence; reads compose from warm raw
// only and never fetch. A failed refresh keeps last-good (see RawStore.setError), so a flaky
// upstream degrades a field-group's freshness rather than dropping it.
import BigNumber from "bignumber.js";
import { env } from "../config/env.ts";
import { PRIMARY_CHAIN_ID, SUPPORTED_CHAIN_IDS } from "../config/chains.ts";
import { log } from "../config/logger.ts";
import { captureError } from "../config/sentry.ts";
import { rawStore, RawStore } from "../cache/store.ts";
import { KEYS, POLICY, type WarmPolicy } from "../cache/policy.ts";
import { readMarkets } from "../data/markets.ts";
import { Market } from "../types/index.ts";

import { fetchStablewatchApy } from "../sources/stablewatch.ts";
import { fetchPendleMarkets } from "../sources/pendle.ts";
import { fetchDefillamaChart, type DefillamaPoint } from "../sources/defillama.ts";
import { fetchRoycoVaultApy, fetchRoycoVaultApyHistory } from "../sources/royco.ts";
import { fetchAllMorphoMarketsData, fetchAllBorrowApyHistories } from "../sources/morpho.ts";
import { fetchMerklIncentiveData } from "../sources/merkl.ts";
import { fetchTokenPrices } from "../sources/coingecko.ts";
import { fetchExitLiquidity, type ExitLiquidityMap } from "../sources/exitLiquidity.ts";
import {
  fetchStUSDApy,
  fetchSpUSDGApy,
  fetchAllCollateralValuesInLoanToken,
  isStUSDS,
  isSpUSDG,
} from "../sources/onchain.ts";
import { registries } from "../data/markets.ts";

// Max jobs fetched concurrently during the initial prime — caps the cold-start burst so upstreams
// (and constrained hosts) aren't hit by every job at once. Steady-state refreshes are unaffected.
const PRIME_CONCURRENCY = 3;

export interface WarmJob {
  name: string;
  key: string;
  policy: WarmPolicy;
  /** true → this job must be primed before /ready flips true. */
  required: boolean;
  run: () => Promise<unknown>;
}

export class Warmer {
  private jobs: WarmJob[] = [];
  private timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(
    private readonly chainId: number,
    private readonly store: RawStore = rawStore,
  ) {}

  private markets(): Market[] {
    return readMarkets(this.chainId);
  }

  private buildJobs(): WarmJob[] {
    const chainId = this.chainId;
    const markets = this.markets();

    const defillamaIds = [
      ...new Set(
        markets.filter((m) => m.collateralToken.info?.defillamaId).map((m) => m.collateralToken.info.defillamaId as string),
      ),
    ];
    const roycoVaults = [
      ...new Set(markets.filter((m) => m.collateralToken.info?.royco).map((m) => m.collateralToken.address)),
    ];
    const hasStUSDS = markets.some((m) => isStUSDS(m.collateralToken.address));
    const hasSpUSDG = markets.some((m) => isSpUSDG(m.collateralToken.address));

    // Every token that needs a USD price (loan tokens + PT underlyings), mirroring FlashLeverage.
    const priceTokens: { address: string; coingeckoId?: string }[] = [
      ...registries.loanTokens.map((t) => ({ address: t.address, coingeckoId: t.coingeckoId })),
      ...markets
        .filter((m) => m.collateralToken.isPt && m.collateralToken.underlying?.coingeckoId)
        .map((m) => ({
          address: m.collateralToken.underlying!.address,
          coingeckoId: m.collateralToken.underlying!.coingeckoId!,
        })),
    ];

    const jobs: WarmJob[] = [
      {
        name: "morpho-markets",
        key: KEYS.morphoMarkets(chainId),
        policy: POLICY.morphoMarkets,
        required: true,
        run: () => fetchAllMorphoMarketsData(chainId, markets),
      },
      {
        name: "morpho-borrow-history",
        key: KEYS.morphoBorrowHistory(chainId),
        policy: POLICY.morphoBorrowHistory,
        required: false,
        run: () => fetchAllBorrowApyHistories(chainId, markets),
      },
      {
        name: "onchain-collateral-value",
        key: KEYS.onchainCollateralValue(chainId),
        policy: POLICY.onchainCollateralValue,
        required: true,
        run: () => fetchAllCollateralValuesInLoanToken(chainId, markets),
      },
      {
        // NOT required: prices only affect USD *display* values, not LTV/leverage/liquidation math.
        // A CoinGecko outage must degrade USD values (the store serves last-good, and priceOf falls
        // back to 1 — exactly what the app does) rather than 503 every strategy read.
        name: "prices",
        key: KEYS.prices(chainId),
        policy: POLICY.prices,
        required: false,
        run: () => fetchTokenPrices(priceTokens),
      },
      {
        name: "stablewatch-apy",
        key: KEYS.stablewatchApy(),
        policy: POLICY.stablewatchApy,
        required: false,
        run: () => fetchStablewatchApy(),
      },
      {
        name: "pendle",
        key: KEYS.pendle(),
        policy: POLICY.pendle,
        required: false,
        run: () => (markets.some((m) => m.collateralToken.isPt) ? fetchPendleMarkets() : Promise.resolve([])),
      },
      {
        name: "defillama",
        key: KEYS.defillamaAll(chainId),
        policy: POLICY.defillama,
        required: false,
        run: async () => {
          const entries = await Promise.all(
            defillamaIds.map((id) =>
              fetchDefillamaChart(id)
                .then((data) => [id, data] as [string, DefillamaPoint[]])
                .catch((e) => {
                  log.warn("defillama id failed", { id, error: String(e) });
                  return [id, [] as DefillamaPoint[]] as [string, DefillamaPoint[]];
                }),
            ),
          );
          return Object.fromEntries(entries);
        },
      },
      {
        name: "royco",
        key: KEYS.roycoAll(chainId),
        policy: POLICY.royco,
        required: false,
        run: async () => {
          const entries = await Promise.all(
            roycoVaults.map(async (address) => {
              const [apyRes, historyRes] = await Promise.allSettled([
                fetchRoycoVaultApy(address, chainId),
                fetchRoycoVaultApyHistory(address, chainId, "3m"),
              ]);
              return [
                address.toLowerCase(),
                {
                  apy: apyRes.status === "fulfilled" ? apyRes.value : BigNumber(0).toFixed(2),
                  history: historyRes.status === "fulfilled" ? historyRes.value : [],
                },
              ] as const;
            }),
          );
          return Object.fromEntries(entries);
        },
      },
      {
        // Exit-liquidity slippage via Kyberswap sweep (replaces the app's manual refresh:liquidity).
        // Merge fresh over prior so a per-token transient failure keeps that token's previous value
        // (fetchExitLiquidity omits transient tokens). Compose falls back to the baked seed until
        // the first successful sweep populates the cache.
        name: "exit-liquidity",
        key: KEYS.exitLiquidity(chainId),
        policy: POLICY.exitLiquidity,
        required: false,
        run: async () => {
          const prior = this.store.view<ExitLiquidityMap>(KEYS.exitLiquidity(chainId))?.value ?? {};
          const fresh = await fetchExitLiquidity(markets);
          return { ...prior, ...fresh };
        },
      },
      {
        name: "merkl",
        key: KEYS.merkl(chainId),
        policy: POLICY.merkl,
        required: false,
        run: async () => {
          const data = await fetchMerklIncentiveData(
            chainId,
            markets.map((m) => m.morphoMarketId),
          );
          // null = unhealthy Merkl (no campaigns chain-wide). Throw so the store keeps last-good
          // rather than overwriting good incentives with an empty snapshot.
          if (data === null) throw new Error("merkl returned no campaigns (unhealthy)");
          return data;
        },
      },
    ];

    if (hasStUSDS) {
      jobs.push({
        name: "onchain-stusds",
        key: KEYS.onchainStUSDS(),
        policy: POLICY.onchainApy,
        required: false,
        run: () => fetchStUSDApy(),
      });
    }
    if (hasSpUSDG) {
      jobs.push({
        name: "onchain-spusdg",
        key: KEYS.onchainSpUSDG(),
        policy: POLICY.onchainApy,
        required: false,
        run: () => fetchSpUSDGApy(),
      });
    }
    return jobs;
  }

  private async runJob(job: WarmJob): Promise<void> {
    const startedAt = Date.now();
    try {
      const value = await job.run();
      this.store.setOk(job.key, value, job.policy.staleAfterSec);
      log.info("warm ok", { job: job.name, key: job.key, ms: Date.now() - startedAt });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.store.setError(job.key, msg, job.policy.staleAfterSec);
      log.warn("warm failed (serving last-good)", { job: job.name, key: job.key, error: msg });
      // Non-required jobs flap transiently (expected — served last-good); only a REQUIRED job
      // failing threatens availability (it can flip /ready and, past grace, fail-close reads).
      if (job.required) captureError(e, { job: job.name, key: job.key });
    }
  }

  /**
   * Fetch every job once (initial prime). REQUIRED jobs are primed first and alone so they get a
   * clean shot at their upstreams (and /ready flips ASAP); the rest follow with bounded concurrency.
   * Firing all jobs at once was a cold-start thundering herd that flaked upstreams (e.g. the Morpho
   * markets fetch) — especially now the exit-liquidity job fans out ~hundreds of quotes.
   */
  async primeOnce(): Promise<void> {
    if (this.jobs.length === 0) this.jobs = this.buildJobs();
    await this.primeBatch(this.jobs.filter((j) => j.required), PRIME_CONCURRENCY);
    await this.primeBatch(this.jobs.filter((j) => !j.required), PRIME_CONCURRENCY);
  }

  /** Run a set of jobs with at most `limit` in flight. runJob never throws (it catches internally). */
  private async primeBatch(jobs: WarmJob[], limit: number): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) await this.runJob(jobs[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  }

  /** Prime once, then schedule each job on its cadence. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!env.WARMER_ENABLED) {
      log.warn("warmer disabled (WARMER_ENABLED=false) — reads will be cold");
      return;
    }
    this.jobs = this.buildJobs();
    log.info("warmer starting", { jobs: this.jobs.map((j) => j.name), chainId: this.chainId });
    await this.primeOnce();
    for (const job of this.jobs) {
      const timer = setInterval(() => void this.runJob(job), job.policy.refreshEverySec * 1000);
      timer.unref?.();
      this.timers.push(timer);
    }
    log.info("warmer primed", { ready: this.isReady() });
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.started = false;
  }

  /** Ready when all `required` jobs have been primed at least once. */
  isReady(): boolean {
    const jobs = this.jobs.length ? this.jobs : this.buildJobs();
    return jobs.filter((j) => j.required).every((j) => this.store.isPrimed(j.key));
  }

  readiness() {
    const jobs = this.jobs.length ? this.jobs : this.buildJobs();
    return jobs.map((j) => ({
      job: j.name,
      key: j.key,
      required: j.required,
      primed: this.store.isPrimed(j.key),
    }));
  }
}

// Coordinator over one Warmer per supported chain. Preserves the single-warmer surface the rest of
// the service calls (start/stop/primeOnce), and adds a chainId argument to the readiness checks so a
// per-request handler can gate on the chain it is actually serving. A secondary chain degrading
// (e.g. its upstreams are down) never blocks the primary — isReady()/readiness() default to primary.
class MultiChainWarmer {
  private readonly warmers = new Map<number, Warmer>();

  constructor(chainIds: number[]) {
    for (const id of chainIds) this.warmers.set(id, new Warmer(id));
  }

  private all(): Warmer[] {
    return [...this.warmers.values()];
  }

  async primeOnce(): Promise<void> {
    await Promise.all(this.all().map((w) => w.primeOnce()));
  }

  async start(): Promise<void> {
    await Promise.all(this.all().map((w) => w.start()));
  }

  stop(): void {
    for (const w of this.all()) w.stop();
  }

  isReady(chainId: number = PRIMARY_CHAIN_ID): boolean {
    return this.warmers.get(chainId)?.isReady() ?? false;
  }

  readiness(chainId: number = PRIMARY_CHAIN_ID) {
    return this.warmers.get(chainId)?.readiness() ?? [];
  }
}

export const warmer = new MultiChainWarmer(SUPPORTED_CHAIN_IDS);
