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
