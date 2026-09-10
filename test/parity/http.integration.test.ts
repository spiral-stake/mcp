// HTTP integration — exercises the real hono app (routing, readiness gate, error envelope, JSON
// serialization) against a seeded raw cache. Complements the pure-composition parity test.
import { describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";
import { app } from "../../src/http/app.ts";
import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readMarkets } from "../../src/data/markets.ts";
import type { MorphoMarketData } from "../../src/sources/morpho.ts";

const CHAIN = 1;
const m0 = readMarkets(CHAIN)[0];

function seedRequired() {
  const morpho: Record<string, MorphoMarketData> = {
    [m0.morphoMarketId]: {
      borrowApy: "5.00",
      quarterlyBorrowApy: "5.10",
      supplyAssets: new BigNumber("1000000"),
      supplyAssetsUsd: 1_000_000,
      liquidityAssetsParsed: 0n,
      liquidityAssets: new BigNumber("400000"),
      liquidityAssetsUsd: 400_000,
      paLiquidityAssets: new BigNumber("500000"),
      paSharedLiquidity: [],
    },
  };
  rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 300);
  rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), { [m0.morphoMarketId]: new BigNumber("1.02") }, 900);
  rawStore.setOk(KEYS.prices(CHAIN), { [m0.loanToken.address]: new BigNumber("1") }, 300);
  rawStore.setOk(KEYS.stablewatchApy(), { stableApy: [{ id: m0.collateralToken.info.stablewatchId, metrics: { apy: { avg7d: 10 } }, history: [] }] }, 43200);
  rawStore.setOk(KEYS.merkl(CHAIN), { spot: {}, histories: {} }, 3600);
}

describe("http surface", () => {
  it("GET /health is always 200 (liveness)", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });

  it("GET /v1/strategies/:id rejects a malformed id with a 400 envelope before the readiness gate", async () => {
    const res = await app.request("/v1/strategies/0xdeadbeef");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.correlationId).toBeTruthy();
    expect(res.headers.get("x-correlation-id")).toBeTruthy();
  });

  // The chart proxy takes caller-supplied coinId/currency; they must be validated (charset +
  // bounds) BEFORE any upstream call, so junk input can't reach CoinGecko or grow the cache.
  it("GET /v1/prices/chart rejects junk coinId/currency/days with 400 (no upstream call)", async () => {
    for (const q of ["", "coinId=bad id", "coinId=x&currency=us d", "coinId=x&days=-1", "coinId=x&days=99999"]) {
      const res = await app.request(`/v1/prices/chart?${q}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe("bad_request");
    }
  });

  // Same discipline for the DEX OHLCV proxy: every caller-supplied dimension is checked against
  // GeckoTerminal's accepted set before any upstream call, so junk can't burn the ~30 req/min budget.
  it("GET /v1/prices/ohlcv rejects junk token/timeframe/aggregate/limit/chain with 400 (no upstream call)", async () => {
    const token = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
    const bad = [
      "",
      "token=cashcat",
      `token=${token}&timeframe=week`,
      `token=${token}&timeframe=hour&aggregate=7`,
      `token=${token}&timeframe=minute&aggregate=4`,
      `token=${token}&limit=0`,
      `token=${token}&limit=1001`,
      `token=${token}&limit=1.5`,
      `token=${token}&chainId=999`,
    ];
    for (const q of bad) {
      const res = await app.request(`/v1/prices/ohlcv?${q}`);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as any).error.code).toBe("bad_request");
    }
  });

  // The app caches this response for 30 minutes, so an empty 200 during a cold start would
  // poison its cache long after recovery. It must 503 instead (the dashboard's old behaviour).
  describe("GET /v1/stable-apy", () => {
    it("503s when there are no pools to serve, so the app never caches an empty snapshot", async () => {
      rawStore.setOk(KEYS.stablewatchApy(), { stableApy: [] }, 43200);
      const res = await app.request("/v1/stable-apy");
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("not_ready");
    });

    it("200s with the pools once primed", async () => {
      rawStore.setOk(
        KEYS.stablewatchApy(),
        { stableApy: [{ id: "0xabc", metrics: { apy: { avg7d: 5 } }, history: [] }] },
        43200,
      );
      const res = await app.request("/v1/stable-apy");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.stableApy).toHaveLength(1);
    });
  });

  // The app renders liquidation prices + maxLeverage from this feed and has no client-side
  // fallback, so serving hours-old borrow/oracle data silently is worse than serving nothing.
  describe("GET /v1/app/markets staleness guard", () => {
    beforeEach(seedRequired);

    it("200s while the critical groups are fresh", async () => {
      const res = await app.request("/v1/app/markets");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.freshness.borrow.staleForSec).toBe(0);
    });

    it("503s when borrow data is stale beyond the grace (maxLeverage would be wrong)", async () => {
      // age 1300s against a 300s budget => staleForSec 1000 > MAX_STALE_GRACE_SEC (900)
      rawStore.setOk(KEYS.morphoMarkets(CHAIN), {}, 300, Date.now() - 1_300_000);
      const res = await app.request("/v1/app/markets");
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("upstream_unavailable");
      expect(body.error.details.group).toBe("borrow");
    });

    it("503s when the oracle read is stale beyond the grace (liquidation price would be wrong)", async () => {
      rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), {}, 900, Date.now() - 1_900_000);
      const res = await app.request("/v1/app/markets");
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.error.details.group).toBe("collateralValue");
    });
  });

  describe("with required data primed", () => {
    beforeEach(seedRequired);

    it("GET /v1/strategies returns 200 with the envelope + a valid strategy", async () => {
      const res = await app.request("/v1/strategies");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.chainId).toBe(CHAIN);
      expect(body.count).toBe(body.strategies.length);
      const s = body.strategies.find((x: { id: string }) => x.id === m0.morphoMarketId);
      expect(s).toBeDefined();
      // numbers serialize as JSON numbers/strings (no BigNumber/bigint leakage)
      expect(typeof s.supplyUsd).toBe("number");
      expect(typeof s.collateralApyPct).toBe("string");
    });

    it("GET /v1/strategies/:id returns the single strategy", async () => {
      const res = await app.request(`/v1/strategies/${m0.morphoMarketId}`);
      expect(res.status).toBe(200);
      const s = (await res.json()) as any;
      expect(s.id).toBe(m0.morphoMarketId);
      expect(s.leverageLadder[0].leverage).toBe("1.0");
    });

    it("GET /v1/prices exposes the warmed prices", async () => {
      const res = await app.request("/v1/prices");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.prices[m0.loanToken.address]).toBe(1);
    });

    it("GET /v1/app/markets serves the raw Market[] with tagged precision values", async () => {
      const res = await app.request("/v1/app/markets");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const m = body.markets.find((x: any) => x.morphoMarketId === m0.morphoMarketId);
      expect(m).toBeDefined();
      // BigNumber / bigint arrive tagged, not as JSON numbers (which would lose precision).
      expect(m.collateralTokenValueInLoanToken).toEqual({ $bn: "1.02" });
      expect(m.marketParams.lltv.$bigint).toBe("945000000000000000");
      // the app's leverage inputs are present
      expect(m.safeLtv).toBe("93.50");
      expect(m.defaultLeverage).toBeTruthy();
    });
  });

  it("GET /v1/stable-apy is not readiness-gated and reports its staleness", async () => {
    rawStore.setOk(KEYS.stablewatchApy(), { stableApy: [{ id: "0xabc", asset: "X" }] }, 43200);
    const res = await app.request("/v1/stable-apy");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.stableApy).toHaveLength(1);
    expect(body.stale).toBe(false);
    expect(body.asOf).toBeTruthy();
  });
});
