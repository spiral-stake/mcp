// OpenAPI 3.1 description of the REST surface — partner-ready and lets the app generate a typed
// client. Hand-authored (no framework) and kept in sync with http/app.ts + types/contract.ts.
import { env } from "../config/env.ts";

export function openApiSpec() {
  const freshnessGroup = {
    type: "object",
    properties: {
      asOf: { type: "string", format: "date-time" },
      staleAfterSec: { type: "integer" },
      staleForSec: { type: "integer", description: "Seconds past the freshness budget; present only when stale." },
    },
    required: ["asOf", "staleAfterSec"],
  };

  const ladderPoint = {
    type: "object",
    properties: {
      leverage: { type: "string", example: "3.0" },
      ltvPct: { type: "string", example: "66.7" },
      leverageApyPct: { type: "string", example: "18.96" },
    },
    required: ["leverage", "ltvPct", "leverageApyPct"],
  };

  const strategy = {
    type: "object",
    description: "Frozen /strategies contract (v1). Raw facts; the only verdict is under spiralHints.",
    properties: {
      id: { type: "string", description: "Morpho market id (0x + 64 hex)." },
      chainId: { type: "integer" },
      correlated: { type: "boolean" },
      collateral: { type: "object" },
      loan: { type: "object" },
      collateralApyPct: { type: "string" },
      collateralApySource: { type: "string", enum: ["pendle", "defillama", "royco", "stablewatch", "onchain", "none"] },
      yieldSustainabilityPct: { type: "object" },
      borrowApyPct: { type: "string" },
      quarterlyBorrowApyPct: { type: "string" },
      borrowIncentive: { type: "object", nullable: true },
      netBorrowApyPct: { type: "string" },
      supplyUsd: { type: "number" },
      liquidityUsd: { type: "number" },
      publicAllocatorLiquidityUsd: { type: "number" },
      maxLeverage: { type: "string" },
      utilizationPct: { type: "string" },
      leverageLadder: { type: "array", items: ladderPoint },
      defaultLeverage: ladderPoint,
      historicalLeverageApyPct: { type: "object" },
      ltvPct: { type: "object", properties: { liquidation: { type: "string" }, max: { type: "string" } } },
      oracle: { type: "object" },
      exitLiquidity: { type: "object" },
      noSwapRoute: { type: "boolean" },
      spiralHints: { type: "object", description: "Optional, namespaced Spiral opinion; carries its thresholds." },
      freshness: {
        type: "object",
        properties: { borrow: freshnessGroup, collateralApy: freshnessGroup, exitLiquidity: freshnessGroup },
      },
      links: { type: "object" },
    },
    required: [
      "id",
      "chainId",
      "correlated",
      "collateral",
      "loan",
      "collateralApyPct",
      "collateralApySource",
      "borrowApyPct",
      "netBorrowApyPct",
      "maxLeverage",
      "leverageLadder",
      "defaultLeverage",
      "ltvPct",
      "exitLiquidity",
      "noSwapRoute",
      "freshness",
    ],
  };

  const errorEnvelope = {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          correlationId: { type: "string" },
          details: {},
        },
        required: ["code", "message", "correlationId"],
      },
    },
  };

  const idParam = {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
    description: "Morpho market id.",
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Spiral Stake — Read API (v1)",
      version: "0.1.0",
      description:
        "Read-only composition authority for Spiral Stake strategy data. Serves the frozen /strategies contract (agents + app) plus the full app read surface. All numbers are composed from warm cache; a stale/failed upstream serves last-good with a visible stale age.",
    },
    servers: [{ url: `http://localhost:${env.PORT}` }],
    paths: {
      "/health": {
        get: {
          summary: "Liveness + cache diagnostics",
          responses: { "200": { description: "OK" } },
        },
      },
      "/ready": {
        get: {
          summary: "Readiness (warmer has primed required data)",
          responses: { "200": { description: "Ready" }, "503": { description: "Warming up" } },
        },
      },
      "/v1/strategies": {
        get: {
          summary: "All strategies (frozen contract)",
          responses: {
            "200": {
              description: "Strategies envelope",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      asOf: { type: "string", format: "date-time" },
                      chainId: { type: "integer" },
                      count: { type: "integer" },
                      strategies: { type: "array", items: strategy },
                    },
                  },
                },
              },
            },
            "503": { description: "Not ready", content: { "application/json": { schema: errorEnvelope } } },
          },
        },
      },
      "/v1/strategies/{id}": {
        get: {
          summary: "One strategy by market id",
          parameters: [idParam],
          responses: {
            "200": { description: "Strategy", content: { "application/json": { schema: strategy } } },
            "400": { description: "Invalid id", content: { "application/json": { schema: errorEnvelope } } },
            "404": { description: "Not found", content: { "application/json": { schema: errorEnvelope } } },
          },
        },
      },
      "/v1/stable-apy": {
        get: {
          summary: "StableWatch stable-pool APY snapshot + history",
          description:
            "The `{ stableApy: [...] }` snapshot the app previously fetched from the dashboard `/apy`. The mcp now owns this data. Not readiness-gated: serves last-good (or an empty list) with a visible stale flag.",
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/app/markets": {
        get: {
          summary: "Full composed Market[] for the v2-client app (raw domain model)",
          description:
            "The internal Market model the app consumes in place of its own client-side composition. Unlike /v1/strategies (curated, string APYs), values keep full precision: BigNumber is tagged as {\"$bn\":\"…\"} and bigint as {\"$bigint\":\"…\"}; revive both client-side before use.",
          responses: {
            "200": { description: "OK" },
            "503": { description: "Not ready", content: { "application/json": { schema: errorEnvelope } } },
          },
        },
      },
      "/v1/markets/borrow-apy-history": {
        get: { summary: "Borrow-APY history for all markets (charts)", responses: { "200": { description: "OK" } } },
      },
      "/v1/markets/{id}/borrow-apy-history": {
        get: { summary: "Borrow-APY history for one market", parameters: [idParam], responses: { "200": { description: "OK" } } },
      },
      "/v1/collateral/apy-history": {
        get: { summary: "Collateral-APY history for all markets (keyed by market id)", responses: { "200": { description: "OK" } } },
      },
      "/v1/collateral/{id}/apy-history": {
        get: { summary: "Collateral-APY history for one market", parameters: [idParam], responses: { "200": { description: "OK" } } },
      },
      "/v1/markets/{id}/incentive-history": {
        get: { summary: "Borrow-incentive (Merkl) APR history for one market", parameters: [idParam], responses: { "200": { description: "OK" } } },
      },
      "/v1/prices": {
        get: { summary: "Latest token/loan USD prices (address → price)", responses: { "200": { description: "OK" } } },
      },
      "/v1/prices/chart": {
        get: {
          summary: "CoinGecko price chart (on-demand proxy)",
          parameters: [
            { name: "coinId", in: "query", required: true, schema: { type: "string" } },
            { name: "days", in: "query", required: false, schema: { type: "integer", default: 7 } },
            { name: "currency", in: "query", required: false, schema: { type: "string", default: "usd" } },
          ],
          responses: { "200": { description: "OK" }, "400": { description: "Bad request" }, "503": { description: "Upstream unavailable" } },
        },
      },
    },
    components: { schemas: { Strategy: strategy, ErrorEnvelope: errorEnvelope } },
  } as const;
}
