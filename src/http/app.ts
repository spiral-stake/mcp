// Thin REST layer over `core`. It is the only thing that knows about requests — routing,
// validation, CORS, the error envelope, and per-request correlation ids. All numbers come from
// `core` (composed from warm raw); handlers never fetch upstreams (except the explicitly
// on-demand CoinGecko price-chart proxy, which is separate from the warmed core).
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import BigNumber from "bignumber.js";
import { PRIMARY_CHAIN_ID, SUPPORTED_CHAIN_IDS, isSupportedChain } from "../config/chains.ts";
import { childLogger } from "../config/logger.ts";
import { ApiError, assertMarketId, errorResponse } from "./errors.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS, MAX_STALE_GRACE_SEC } from "../cache/policy.ts";
import { warmer } from "../warmer/index.ts";
import { buildStrategies, buildStrategy } from "../core/strategy.ts";
import { composeSnapshot } from "../core/compose.ts";
import { fetchMarketChart } from "../sources/coingecko.ts";
import { buildAppMarkets } from "./appMarkets.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "../mcp/server.ts";
import type { ApySnapshot } from "../sources/stablewatch.ts";
import { openApiSpec } from "./openapi.ts";
import serverManifest from "../../server.json" with { type: "json" };
import { captureError } from "../config/sentry.ts";
import type { BorrowHistoryPoint } from "../sources/morpho.ts";
import type { MerklIncentiveData } from "../sources/merkl.ts";

type Vars = { cid: string; log: ReturnType<typeof childLogger> };

export const app = new Hono<{ Variables: Vars }>();

// Which chain a request targets: ?chainId (validated against the supported set), default = primary.
function chainOf(c: Context): number {
  const raw = c.req.query("chainId");
  if (raw == null || raw === "") return PRIMARY_CHAIN_ID;
  const id = Number(raw);
  if (!Number.isInteger(id) || !isSupportedChain(id)) {
    throw new ApiError("bad_request", `Unsupported chainId '${raw}'. Supported: ${SUPPORTED_CHAIN_IDS.join(", ")}`);
  }
  return id;
}

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

// ── CORS — public read API, all origins allowed. POST + MCP headers for the /mcp endpoint. ──
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", "x-correlation-id", "mcp-session-id", "mcp-protocol-version"],
    exposeHeaders: ["mcp-session-id"],
  }),
);

// ── error handling ──
app.onError((err, c) => {
  const log = c.get("log");
  const cid = c.get("cid");
  if (err instanceof ApiError) {
    // Only 5xx-class internal errors are our fault; 4xx (bad_request/not_found) are client input.
    if (err.code === "internal") {
      log?.error("api error", { code: err.code, message: err.message });
      captureError(err, { cid, path: c.req.path });
    }
    return errorResponse(c, err);
  }
  log?.error("unhandled error", { message: err instanceof Error ? err.message : String(err) });
  captureError(err, { cid, path: c.req.path });
  return errorResponse(c, new ApiError("internal", "Internal server error"));
});

function requireReady(chainId: number) {
  if (!warmer.isReady(chainId)) {
    throw new ApiError("not_ready", "Service is warming up — required data not yet primed", warmer.readiness(chainId));
  }
}

// Groups whose staleness would silently corrupt what the app renders: borrow APY + liquidity
// (drive maxLeverage) and the oracle read (drives liquidation price). Serving hours-old values
// here is worse than serving nothing, so past MAX_STALE_GRACE_SEC we 503 and let the app surface
// an error. Prices are deliberately excluded — they only affect USD display and are allowed to
// degrade (see the warmer: `prices` is not a required job).
function requireFreshMarketData(chainId: number) {
  const critical: [string, string][] = [
    ["borrow", KEYS.morphoMarkets(chainId)],
    ["collateralValue", KEYS.onchainCollateralValue(chainId)],
  ];
  for (const [group, key] of critical) {
    const view = rawStore.view(key);
    if (!view || view.staleForSec > MAX_STALE_GRACE_SEC) {
      throw new ApiError("upstream_unavailable", `Market data is too stale to serve (${group})`, {
        group,
        asOf: view?.asOf ?? null,
        staleForSec: view?.staleForSec ?? null,
      });
    }
  }
}

// ── liveness / readiness ──
app.get("/health", (c) =>
  c.json({ status: "ok", uptimeSec: Math.floor(process.uptime()), chainIds: SUPPORTED_CHAIN_IDS, cache: rawStore.stats() }),
);

app.get("/ready", (c) => {
  const chainId = chainOf(c);
  const ready = warmer.isReady(chainId);
  return c.json({ chainId, ready, readiness: warmer.readiness(chainId) }, ready ? 200 : 503);
});

// ── service info + OpenAPI ──
app.get("/", (c) =>
  c.json({
    service: "spiralstake-mcp",
    description: "Composition authority + read API for Spiral Stake strategy data.",
    chainIds: SUPPORTED_CHAIN_IDS,
    primaryChainId: PRIMARY_CHAIN_ID,
    endpoints: ["/mcp", "/v1/strategies", "/v1/strategies/:id", "/health", "/ready", "/openapi.json"],
    note: "All /v1 read endpoints accept ?chainId to target a supported chain (default = primaryChainId).",
    mcp: "/mcp",
    docs: "/openapi.json",
  }),
);
app.get("/openapi.json", (c) => c.json(openApiSpec()));

// Same-origin MCP discovery: a client holding the /mcp URL can find the server descriptor here.
// Served straight from the registry manifest so it never drifts.
app.get("/.well-known/mcp.json", (c) => c.json(serverManifest));

// ── MCP (Model Context Protocol) — native tool surface for agents over Streamable HTTP ──
// Stateless: a fresh server+transport per request (no session state), which suits read-only tools
// and lets any spec-compliant MCP client (Claude, Cursor, …) connect at this URL.
app.all("/mcp", async (c) => {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(c.req.raw);
  // enableJsonResponse buffers the full response, so closing on the next tick can't truncate it.
  setTimeout(() => {
    transport.close();
    server.close();
  }, 0);
  return res;
});

// ── v1: strategies (agents + app) ──
app.get("/v1/strategies", (c) => {
  const chainId = chainOf(c);
  requireReady(chainId);
  return c.json(buildStrategies(chainId));
});

app.get("/v1/strategies/:id", (c) => {
  const chainId = chainOf(c);
  const id = assertMarketId(c.req.param("id")); // validate before the readiness gate (clearer 400)
  requireReady(chainId);
  const strategy = buildStrategy(chainId, id);
  if (!strategy) throw new ApiError("not_found", `No strategy for market ${id}`);
  return c.json(strategy);
});

// ── v1: app-surface — StableWatch stable-APY snapshot (replaces the dashboard /apy the app used) ──
// Same `{ stableApy: [...] }` shape the dashboard served, so the app's getApySnapshot consumers
// (getApyChart) work unchanged. Once primed the store serves last-good, so a StableWatch outage
// still returns the previous pools rather than an empty set.
//
// 503 (never 200-with-empty) when there is nothing to serve: the app caches this response for 30
// minutes, so a 200 with `stableApy: []` during a cold start would poison its cache long after we
// recovered. Mirrors the dashboard's old `503 "APY data not yet available"`, which the app's
// callers already handle by degrading (empty chart) and retrying.
app.get("/v1/stable-apy", (c) => {
  const view = rawStore.view<ApySnapshot>(KEYS.stablewatchApy());
  const stableApy = view?.value?.stableApy ?? [];
  if (stableApy.length === 0) throw new ApiError("not_ready", "APY data not yet available");
  return c.json({ asOf: view?.asOf ?? null, stale: view?.stale ?? true, stableApy });
});

// ── v1: app-surface — full composed Market[] (raw, tagged BigNumber/bigint) ──
// The v2-client consumes this to replace its own client-side composition (LTV-independent data).
app.get("/v1/app/markets", (c) => {
  const chainId = chainOf(c);
  requireReady(chainId);
  requireFreshMarketData(chainId);
  return c.json(buildAppMarkets(chainId));
});

// ── v1: app-surface — borrow-APY history (charts) ──
app.get("/v1/markets/borrow-apy-history", (c) => {
  const chainId = chainOf(c);
  const view = rawStore.view<Record<string, BorrowHistoryPoint[]>>(KEYS.morphoBorrowHistory(chainId));
  return c.json({
    asOf: view?.asOf ?? null,
    stale: view?.stale ?? true,
    histories: view?.value ?? {},
  });
});

app.get("/v1/markets/:id/borrow-apy-history", (c) => {
  const chainId = chainOf(c);
  const id = assertMarketId(c.req.param("id"));
  const view = rawStore.view<Record<string, BorrowHistoryPoint[]>>(KEYS.morphoBorrowHistory(chainId));
  const history = view?.value?.[id] ?? [];
  return c.json({ id, asOf: view?.asOf ?? null, stale: view?.stale ?? true, history });
});

// ── v1: app-surface — collateral-APY history (charts + windows) ──
// Keyed by market id, matching how the app keys apyHistories (morphoMarketId).
app.get("/v1/collateral/apy-history", (c) => {
  const chainId = chainOf(c);
  requireReady(chainId);
  const snapshot = composeSnapshot(chainId);
  const histories = Object.fromEntries(snapshot.markets.map((m) => [m.market.morphoMarketId, m.apyHistory]));
  return c.json({ asOf: snapshot.asOf, histories });
});

app.get("/v1/collateral/:id/apy-history", (c) => {
  const chainId = chainOf(c);
  const id = assertMarketId(c.req.param("id"));
  const snapshot = composeSnapshot(chainId);
  const cm = snapshot.markets.find((m) => m.market.morphoMarketId.toLowerCase() === id.toLowerCase());
  if (!cm) throw new ApiError("not_found", `No market ${id}`);
  return c.json({ id, asOf: snapshot.asOf, history: cm.apyHistory });
});

// ── v1: app-surface — borrow-incentive history (Merkl) ──
app.get("/v1/markets/:id/incentive-history", (c) => {
  const chainId = chainOf(c);
  const id = assertMarketId(c.req.param("id"));
  const view = rawStore.view<MerklIncentiveData>(KEYS.merkl(chainId));
  const history = view?.value?.histories?.[id.toLowerCase()] ?? [];
  return c.json({ id, asOf: view?.asOf ?? null, stale: view?.stale ?? true, history });
});

// ── v1: app-surface — token/loan USD prices ──
app.get("/v1/prices", (c) => {
  const chainId = chainOf(c);
  const view = rawStore.view<Record<string, BigNumber>>(KEYS.prices(chainId));
  const raw = view?.value ?? {};
  const prices: Record<string, number> = {};
  for (const [address, price] of Object.entries(raw)) {
    prices[address] = price instanceof BigNumber ? price.toNumber() : Number(price);
  }
  return c.json({ asOf: view?.asOf ?? null, stale: view?.stale ?? true, prices });
});

// ── v1: app-surface — CoinGecko price chart (ON-DEMAND proxy, small TTL cache) ──
// `coinId`/`currency` are caller-supplied, so the cache MUST be bounded or it becomes an unbounded
// memory sink (a client spraying distinct coinIds). Bounded LRU: on insert, evict expired entries,
// then the oldest until under MAX. Input is also validated to a conservative charset + allowlist.
const chartCache = new Map<string, { at: number; data: unknown }>();
const CHART_TTL_MS = 5 * 60 * 1000;
const CHART_CACHE_MAX = 500;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i; // CoinGecko ids / currency codes are short slugs

function chartCacheSet(key: string, data: unknown) {
  const now = Date.now();
  for (const [k, v] of chartCache) if (now - v.at >= CHART_TTL_MS) chartCache.delete(k);
  chartCache.set(key, { at: now, data });
  while (chartCache.size > CHART_CACHE_MAX) {
    const oldest = chartCache.keys().next().value; // Map preserves insertion order → oldest first
    if (oldest === undefined) break;
    chartCache.delete(oldest);
  }
}

app.get("/v1/prices/chart", async (c) => {
  const coinId = c.req.query("coinId");
  const days = Number(c.req.query("days") ?? "7");
  const currency = c.req.query("currency") ?? "usd";
  if (!coinId || !ID_RE.test(coinId)) throw new ApiError("bad_request", "valid coinId query param is required");
  if (!ID_RE.test(currency)) throw new ApiError("bad_request", "invalid currency");
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new ApiError("bad_request", "days must be 1..3650");

  const key = `${coinId}:${days}:${currency}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < CHART_TTL_MS) return c.json(hit.data as object);
  try {
    const data = await fetchMarketChart(coinId, days, currency);
    chartCacheSet(key, data);
    return c.json(data);
  } catch (e) {
    throw new ApiError("upstream_unavailable", `CoinGecko chart unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
});

app.notFound((c) => errorResponse(c, new ApiError("not_found", `No route for ${c.req.method} ${c.req.path}`)));
