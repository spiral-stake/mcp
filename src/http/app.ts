// Thin REST layer over `core`. It is the only thing that knows about requests — routing,
// validation, CORS, the error envelope, and per-request correlation ids. All numbers come from
// `core` (composed from warm raw); handlers never fetch upstreams (except the explicitly
// on-demand CoinGecko price-chart proxy, which is separate from the warmed core).
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import BigNumber from "bignumber.js";
import { env } from "../config/env.ts";
import { childLogger } from "../config/logger.ts";
import { ApiError, assertMarketId, errorResponse } from "./errors.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS } from "../cache/policy.ts";
import { warmer } from "../warmer/index.ts";
import { buildStrategies, buildStrategy } from "../core/strategy.ts";
import { composeSnapshot } from "../core/compose.ts";
import { fetchMarketChart } from "../sources/coingecko.ts";
import { buildAppMarkets } from "./appMarkets.ts";
import type { ApySnapshot } from "../sources/stablewatch.ts";
import { openApiSpec } from "./openapi.ts";
import type { BorrowHistoryPoint } from "../sources/morpho.ts";
import type { MerklIncentiveData } from "../sources/merkl.ts";

type Vars = { cid: string; log: ReturnType<typeof childLogger> };
const chainId = env.CHAIN_ID;

export const app = new Hono<{ Variables: Vars }>();

// ── correlation id + structured request logging ──
app.use("*", async (c, next) => {
  const cid = c.req.header("x-correlation-id") ?? randomUUID();
  const log = childLogger(cid);
  c.set("cid", cid);
  c.set("log", log);
  c.header("x-correlation-id", cid);
  const startedAt = Date.now();
  await next();
  log.info("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - startedAt,
  });
});

// ── CORS — public read API, all origins allowed ──
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["content-type", "x-correlation-id"],
  }),
);

// ── error handling ──
app.onError((err, c) => {
  const log = c.get("log");
  if (err instanceof ApiError) {
    if (err.code === "internal") log?.error("api error", { code: err.code, message: err.message });
    return errorResponse(c, err);
  }
  log?.error("unhandled error", { message: err instanceof Error ? err.message : String(err) });
  return errorResponse(c, new ApiError("internal", "Internal server error"));
});

function requireReady() {
  if (!warmer.isReady()) {
    throw new ApiError("not_ready", "Service is warming up — required data not yet primed", warmer.readiness());
  }
}

// ── liveness / readiness ──
app.get("/health", (c) =>
  c.json({ status: "ok", uptimeSec: Math.floor(process.uptime()), chainId, cache: rawStore.stats() }),
);

app.get("/ready", (c) => {
  const ready = warmer.isReady();
  return c.json({ ready, readiness: warmer.readiness() }, ready ? 200 : 503);
});

// ── service info + OpenAPI ──
app.get("/", (c) =>
  c.json({
    service: "spiralstake-mcp",
    description: "Composition authority + read API for Spiral Stake strategy data.",
    chainId,
    endpoints: ["/v1/strategies", "/v1/strategies/:id", "/health", "/ready", "/openapi.json"],
    docs: "/openapi.json",
  }),
);
app.get("/openapi.json", (c) => c.json(openApiSpec()));

// ── v1: strategies (agents + app) ──
app.get("/v1/strategies", (c) => {
  requireReady();
  return c.json(buildStrategies(chainId));
});

app.get("/v1/strategies/:id", (c) => {
  const id = assertMarketId(c.req.param("id")); // validate before the readiness gate (clearer 400)
  requireReady();
  const strategy = buildStrategy(chainId, id);
  if (!strategy) throw new ApiError("not_found", `No strategy for market ${id}`);
  return c.json(strategy);
});

// ── v1: app-surface — StableWatch stable-APY snapshot (replaces the dashboard /apy the app used) ──
// Same `{ stableApy: [...] }` shape the dashboard served, so the app's getApySnapshot consumers
// (getTokenApy history, getApyChart) work unchanged. Not readiness-gated: serves last-good/empty.
app.get("/v1/stable-apy", (c) => {
  const view = rawStore.view<ApySnapshot>(KEYS.stablewatchApy());
  return c.json({ asOf: view?.asOf ?? null, stale: view?.stale ?? true, stableApy: view?.value?.stableApy ?? [] });
});

// ── v1: app-surface — full composed Market[] (raw, tagged BigNumber/bigint) ──
// The v2-client consumes this to replace its own client-side composition (LTV-independent data).
app.get("/v1/app/markets", (c) => {
  requireReady();
  return c.json(buildAppMarkets(chainId));
});

// ── v1: app-surface — borrow-APY history (charts) ──
app.get("/v1/markets/borrow-apy-history", (c) => {
  const view = rawStore.view<Record<string, BorrowHistoryPoint[]>>(KEYS.morphoBorrowHistory(chainId));
  return c.json({
    asOf: view?.asOf ?? null,
    stale: view?.stale ?? true,
    histories: view?.value ?? {},
  });
});

app.get("/v1/markets/:id/borrow-apy-history", (c) => {
  const id = assertMarketId(c.req.param("id"));
  const view = rawStore.view<Record<string, BorrowHistoryPoint[]>>(KEYS.morphoBorrowHistory(chainId));
  const history = view?.value?.[id] ?? [];
  return c.json({ id, asOf: view?.asOf ?? null, stale: view?.stale ?? true, history });
});

// ── v1: app-surface — collateral-APY history (charts + windows) ──
// Keyed by market id, matching how the app keys apyHistories (morphoMarketId).
app.get("/v1/collateral/apy-history", (c) => {
  requireReady();
  const snapshot = composeSnapshot(chainId);
  const histories = Object.fromEntries(snapshot.markets.map((m) => [m.market.morphoMarketId, m.apyHistory]));
  return c.json({ asOf: snapshot.asOf, histories });
});

app.get("/v1/collateral/:id/apy-history", (c) => {
  const id = assertMarketId(c.req.param("id"));
  const snapshot = composeSnapshot(chainId);
  const cm = snapshot.markets.find((m) => m.market.morphoMarketId.toLowerCase() === id.toLowerCase());
  if (!cm) throw new ApiError("not_found", `No market ${id}`);
  return c.json({ id, asOf: snapshot.asOf, history: cm.apyHistory });
});

// ── v1: app-surface — borrow-incentive history (Merkl) ──
app.get("/v1/markets/:id/incentive-history", (c) => {
  const id = assertMarketId(c.req.param("id"));
  const view = rawStore.view<MerklIncentiveData>(KEYS.merkl(chainId));
  const history = view?.value?.histories?.[id.toLowerCase()] ?? [];
  return c.json({ id, asOf: view?.asOf ?? null, stale: view?.stale ?? true, history });
});

// ── v1: app-surface — token/loan USD prices ──
app.get("/v1/prices", (c) => {
  const view = rawStore.view<Record<string, BigNumber>>(KEYS.prices(chainId));
  const raw = view?.value ?? {};
  const prices: Record<string, number> = {};
  for (const [address, price] of Object.entries(raw)) {
    prices[address] = price instanceof BigNumber ? price.toNumber() : Number(price);
  }
  return c.json({ asOf: view?.asOf ?? null, stale: view?.stale ?? true, prices });
});

// ── v1: app-surface — CoinGecko price chart (ON-DEMAND proxy, small TTL cache) ──
const chartCache = new Map<string, { at: number; data: unknown }>();
const CHART_TTL_MS = 5 * 60 * 1000;
app.get("/v1/prices/chart", async (c) => {
  const coinId = c.req.query("coinId");
  const days = Number(c.req.query("days") ?? "7");
  const currency = c.req.query("currency") ?? "usd";
  if (!coinId) throw new ApiError("bad_request", "coinId query param is required");
  if (!Number.isFinite(days) || days <= 0) throw new ApiError("bad_request", "days must be a positive number");

  const key = `${coinId}:${days}:${currency}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < CHART_TTL_MS) return c.json(hit.data as object);
  try {
    const data = await fetchMarketChart(coinId, days, currency);
    chartCache.set(key, { at: Date.now(), data });
    return c.json(data);
  } catch (e) {
    throw new ApiError("upstream_unavailable", `CoinGecko chart unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
});

app.notFound((c) => errorResponse(c, new ApiError("not_found", `No route for ${c.req.method} ${c.req.path}`)));
