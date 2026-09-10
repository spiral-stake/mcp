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
      pointsIncentive: {
        type: "object",
        nullable: true,
        description: "Off-chain points program on the collateral (e.g. Tori Cores). Not a yield. Accrues to the position proxy on the leveraged balance: effective = perDayPerCollateralToken x leverage x tokens.",
        properties: {
          program: { type: "string", example: "Tori Cores" },
          perDayPerCollateralToken: { type: "number", example: 5 },
        },
      },
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

  const chainIdQuery = {
    name: "chainId",
    in: "query",
    required: false,
    schema: { type: "integer", enum: [1, 4663], default: 1 },
    description: "Chain to target — 1 = Ethereum (default), 4663 = Robinhood Chain.",
  };

  // ── Partner (integration API) schemas ──
  const call = { type: "object", properties: { to: { type: "string" }, data: { type: "string" }, value: { type: "string" } }, required: ["to", "data"] };
  const positionPreview = {
    type: "object",
    properties: {
      leverage: { type: "string", example: "3.0" },
      requestedLtv: { type: "string", example: "66.67" },
      effectiveLtv: { type: "string", example: "66.73" },
      amountLeveragedCollateral: { type: "string" },
      expectedLeverageApy: { type: "string", example: "5.64" },
      priceImpactPct: { type: "string", example: "0.07" },
      swapSource: { type: "string", enum: ["KyberSwap", "OpenOcean", "Pendle"], example: "KyberSwap" },
    },
  };
  const unsignedTxBundle = {
    type: "object",
    description: "Unsigned transaction bundle. Non-custodial: sign approvals[] first, then tx, from userAddress.",
    properties: {
      chainId: { type: "integer" },
      action: { type: "string", example: "open_leverage" },
      path: { type: "string", enum: ["leverage", "swapAndLeverage", "reallocateAndLeverage", "reallocateSwapAndLeverage", "deleverage", "increaseLeverage", "supplyCollateral", "swapAndSupplyCollateral", "repay", "swapAndRepay", "withdrawCollateral", "borrow"] },
      approvals: { type: "array", items: call },
      tx: call,
      meta: {
        type: "object",
        properties: {
          positionPreview,
          amountFlashLoan: { type: "string" },
          minTokenOut: { type: "string" },
          slippage: { type: "number" },
          expiresAt: { type: "string", format: "date-time", description: "Swap calldata is time-sensitive (~60s); rebuild if it lapses." },
          signingUrl: { type: "string", description: "One-click link to review + sign in the user's own wallet via the Spiral app." },
          instructions: { type: "string" },
        },
      },
    },
    required: ["chainId", "action", "path", "approvals", "tx", "meta"],
  };
  const simulateResult = {
    type: "object",
    properties: {
      path: { type: "string" }, isDirect: { type: "boolean" }, isReallocate: { type: "boolean" },
      positionPreview, amountFlashLoan: { type: "string" }, minTokenOut: { type: "string" },
      reallocationFeeWei: { type: "string", nullable: true }, slippage: { type: "number" }, note: { type: "string" },
    },
  };
  const leverageBody = {
    type: "object",
    required: ["strategyId", "payToken", "amount"],
    properties: {
      strategyId: { type: "string", description: "Morpho market id (from /v1/strategies)." },
      payToken: { type: "string", description: "Token to pay in. Collateral (direct) or any token (zapped). ETH = zero address." },
      amount: { type: "string", description: "Amount of payToken in human units, e.g. '10000'." },
      leverage: { type: "number", description: "Target leverage (e.g. 3). Provide this OR desiredLtv." },
      desiredLtv: { type: "string", description: "Target LTV percent (e.g. '66.67'). Provide this OR leverage." },
      slippage: { type: "number", description: "Ratio, default 0.005, capped at 0.01." },
      chainId: { type: "integer", enum: [1, 4663] },
    },
  };
  const buildLeverageBody = {
    allOf: [leverageBody, { type: "object", required: ["userAddress"], properties: { userAddress: { type: "string", description: "Wallet that will sign; approvals + onBehalfOf are built for it." } } }],
  };
  const manageBody = {
    type: "object",
    required: ["userAddress", "id", "action"],
    properties: {
      userAddress: { type: "string" },
      id: { type: "integer", description: "On-chain position index (from /positions)." },
      action: { type: "string", enum: ["close", "increase_leverage", "add_collateral", "remove_collateral", "repay", "borrow"] },
      amount: { type: "string" },
      payToken: { type: "string" },
      full: { type: "boolean", description: "repay only: clear the entire remaining debt." },
      desiredLtv: { type: "string" },
      leverage: { type: "number" },
      slippage: { type: "number" },
      chainId: { type: "integer", enum: [1, 4663] },
    },
  };
  const tvlTotals = {
    type: "object",
    properties: {
      tvlUsd: { type: "number", description: "Net user equity in USD (collateral − debt); the DefiLlama TVL. 2 decimals." },
      grossTvlUsd: { type: "number", description: "Total looped collateral in USD. 2 decimals." },
      borrowedUsd: { type: "number", description: "Total debt owed to Morpho in USD. 2 decimals." },
      positions: { type: "integer", description: "Open positions with non-zero collateral." },
      users: { type: "integer", description: "Distinct users with at least one such position." },
    },
    required: ["tvlUsd", "grossTvlUsd", "borrowedUsd", "positions", "users"],
  };
  const tvlResponse = {
    type: "object",
    properties: {
      asOf: { type: "string", format: "date-time", description: "Oldest chain snapshot." },
      stale: { type: "boolean", description: "True if any chain's snapshot is past its freshness budget." },
      total: tvlTotals,
      chains: {
        type: "array",
        items: {
          type: "object",
          properties: {
            chainId: { type: "integer" },
            asOf: { type: "string", format: "date-time" },
            stale: { type: "boolean" },
            ...tvlTotals.properties,
          },
          required: ["chainId", "asOf", "stale", ...tvlTotals.required],
        },
      },
    },
    required: ["asOf", "stale", "total", "chains"],
  };

  const bearer = [{ bearerAuth: [] }];
  const partnerErr = {
    "400": { description: "Invalid input", content: { "application/json": { schema: errorEnvelope } } },
    "401": { description: "Missing/invalid API key", content: { "application/json": { schema: errorEnvelope } } },
    "429": { description: "Rate limited", content: { "application/json": { schema: errorEnvelope } } },
    "503": { description: "Transient (stale data / no route / RPC) — retry", content: { "application/json": { schema: errorEnvelope } } },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Spiral Stake — Read API (v1)",
      version: "0.1.0",
      description:
        "Read-only composition authority for Spiral Stake strategy data. Serves the frozen /strategies contract (agents + app) plus the full app read surface. All numbers are composed from warm cache; a stale/failed upstream serves last-good with a visible stale age.",
    },
    servers: [
      { url: "https://api.spiralstake.xyz", description: "Production" },
      { url: `http://localhost:${env.PORT}`, description: "Local" },
    ],
    tags: [
      { name: "Public", description: "Open read endpoints — no key required." },
      { name: "Partner", description: "Keyed integration API — Authorization: Bearer <key>." },
    ],
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
          tags: ["Public"],
          summary: "All strategies (frozen contract)",
          parameters: [chainIdQuery],
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
      "/v1/tvl": {
        get: {
          tags: ["Public"],
          summary: "Protocol TVL across all supported chains",
          description:
            "Aggregated over every open Spiral position (each held by a UserProxy on a Morpho Blue market). `tvlUsd` = net user equity (collateral − debt) — the figure DefiLlama lists as TVL; `grossTvlUsd` = total looped collateral; `borrowedUsd` = total debt owed to Morpho. `tvlUsd + borrowedUsd = grossTvlUsd`. `positions` counts open positions with non-zero collateral and `users` the distinct wallets holding one. Top-level `asOf` is the oldest chain snapshot and `stale` is true if any chain is stale. Chains not yet computed are omitted; 503 until at least one is.",
          responses: {
            "200": {
              description: "TVL envelope",
              content: { "application/json": { schema: tvlResponse } },
            },
            "503": { description: "Not ready (no chain computed yet)", content: { "application/json": { schema: errorEnvelope } } },
          },
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
        get: { tags: ["Public"], summary: "Latest token/loan USD prices (address → price)", parameters: [chainIdQuery], responses: { "200": { description: "OK" } } },
      },
      "/v1/partner/leverage/simulate": {
        post: {
          tags: ["Partner"],
          summary: "Preview opening a leveraged position (deterministic, no wallet)",
          security: bearer,
          requestBody: { required: true, content: { "application/json": { schema: leverageBody } } },
          responses: { "200": { description: "Position preview", content: { "application/json": { schema: simulateResult } } }, ...partnerErr },
        },
      },
      "/v1/partner/leverage/build": {
        post: {
          tags: ["Partner"],
          summary: "Build the unsigned open-leverage transaction",
          security: bearer,
          requestBody: { required: true, content: { "application/json": { schema: buildLeverageBody } } },
          responses: { "200": { description: "Unsigned tx bundle", content: { "application/json": { schema: unsignedTxBundle } } }, ...partnerErr },
        },
      },
      "/v1/partner/manage/build": {
        post: {
          tags: ["Partner"],
          summary: "Build the unsigned manage/close transaction for a position",
          security: bearer,
          requestBody: { required: true, content: { "application/json": { schema: manageBody } } },
          responses: { "200": { description: "Unsigned tx bundle", content: { "application/json": { schema: unsignedTxBundle } } }, ...partnerErr },
        },
      },
      "/v1/partner/positions/{address}": {
        get: {
          tags: ["Partner"],
          summary: "A wallet's open/closed positions",
          security: bearer,
          parameters: [
            { name: "address", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, description: "Wallet address." },
            chainIdQuery,
          ],
          responses: { "200": { description: "Positions", content: { "application/json": { schema: { type: "object", properties: { chainId: { type: "integer" }, userAddress: { type: "string" }, positions: { type: "array", items: { type: "object" } } } } } } }, ...partnerErr },
        },
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
      "/v1/prices/ohlcv": {
        get: {
          summary: "DEX OHLCV price chart (on-demand GeckoTerminal proxy, 30s cache)",
          description:
            "USD candles from the deepest DEX pool holding `token`, for collateral with no CoinGecko/TradingView chart. `stale: true` means the upstream failed and the previous candles (≤10 min old) are being served.",
          parameters: [
            { name: "chainId", in: "query", required: false, schema: { type: "integer" } },
            { name: "token", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
            { name: "timeframe", in: "query", required: false, schema: { type: "string", enum: ["minute", "hour", "day"], default: "hour" } },
            { name: "aggregate", in: "query", required: false, schema: { type: "integer", default: 1 }, description: "minute: 1|5|15, hour: 1|4|12, day: 1" },
            { name: "limit", in: "query", required: false, schema: { type: "integer", default: 168, minimum: 1, maximum: 1000 } },
          ],
          responses: {
            "200": { description: "OK" },
            "400": { description: "Bad request" },
            "404": { description: "No DEX pool indexed for the token" },
            "503": { description: "Upstream unavailable" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Partner API key: `Authorization: Bearer <key>`." },
      },
      schemas: { Strategy: strategy, ErrorEnvelope: errorEnvelope, UnsignedTxBundle: unsignedTxBundle },
    },
  } as const;
}
