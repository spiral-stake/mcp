# Spiral Stake — `mcp` read-data backbone (Step 1a)

The **composition authority + read API** for Spiral Stake strategy data. It ports the app's
client-side data composition **server-side** and serves it back as JSON, so three consumers run
off one core:

1. **The app** — the complete read surface it currently fetches, for a like-for-like Step-2 swap.
2. **Agents** — the frozen [`/strategies` contract](./CONTRACT.md).
3. **Partners (later)** — a clean, versioned, self-documenting REST surface (OpenAPI).

**Read-only.** No contract writes, no tx building, no signing, no private keys. It composes
numbers and serves JSON. The MCP tool layer, execution/`build_*`, and partner auth are **later
steps** — the seams are pre-cut (`core` + `http`) but not built.

---

## Architecture

```
src/
  core/        pure composition — no I/O, unit-testable
    leverage.ts        ← VERBATIM copy of v2-client/src/utils/leverage.ts (byte-diff gated)
    apy.ts             collateral-APY resolution (Pendle/DeFiLlama/Royco/StableWatch/on-chain)
    leverageApy.ts     30/60/90d leveraged-APY windows + lumpy-token smoothing
    compose.ts         Market assembly from warm raw (port of FlashLeverage.createInstance)
    strategy.ts        Market → frozen /strategies contract (ladder, freshness, spiralHints)
    exitLiquidity.ts   exit-liquidity tier (the single verdict) + thresholds
  sources/     one adapter per upstream (fetch + parse). native fetch + viem; no axios/wagmi
  cache/       two-layer cache — RAW store (last-good) + warming policy (CONTRACT cadences)
  warmer/      background scheduler (stale-while-revalidate); reads NEVER fetch
  http/        thin hono REST layer (the only thing that knows about requests)
  data/        static market config (copied from the app) + readMarkets port
  config/      env (validated) + structured logger with correlation ids
```

**Data flow:** `warmer` fetches upstreams on the CONTRACT cadence → writes **raw** to the cache
(last-good on failure) → `core` composes strategies from **warm raw only** → `http` serves them.
A stale/failed upstream serves **last-good with a visible stale age** per field-group — never
dropped, never coerced to 0.

---

## Run

```bash
cp .env.example .env      # fill in RPC + API keys (secrets via env only)
npm install
npm run dev               # tsx watch; serves on :$PORT (default 8787)
npm test                  # golden + parity gates
npm run typecheck         # tsc --noEmit
npm run openapi           # (re)emit openapi.json
node --import tsx scripts/smoke.ts   # live: prime + print one composed strategy
```

`/health` (liveness + cache diagnostics) and `/ready` (503 until the warmer primes the required
data) are available immediately on boot.

---

## Endpoints — app-read inventory → endpoint mapping

Every data read the app performs in `v2-client/src/api-services/*` maps to an endpoint here
(positions stay on the dashboard backend and are **not** reimplemented):

| App read (`api-services/*`) | mcp endpoint |
|---|---|
| `getTokenApy`, `getAllMorphoMarketsData`, `fetchMerklSpotIncentives`, prices, on-chain value → composed markets | `GET /v1/strategies`, `GET /v1/strategies/:id` |
| `FlashLeverage.createInstance` → the app's full client-side `Market[]` composition | `GET /v1/app/markets` (raw domain model; `BigNumber`→`{"$bn":…}`, `bigint`→`{"$bigint":…}` — revive before use) |
| `morpho.ts` `getAllBorrowApyHistories` / `getBorrowApyHistory` | `GET /v1/markets/borrow-apy-history`, `GET /v1/markets/:id/borrow-apy-history` |
| `apy.ts` `resolveTokenApyHistory` (DeFiLlama/Royco/StableWatch history), `chart.ts` `getApyChart` | `GET /v1/collateral/apy-history`, `GET /v1/collateral/:id/apy-history` |
| `merkl.ts` `fetchMerklIncentiveData` (borrow-incentive APR history) | `GET /v1/markets/:id/incentive-history` |
| `token.ts` `getAllLoanTokenPrices` / `getTokenPrice` | `GET /v1/prices` |
| `chart.ts` `getMarketChart` (CoinGecko price chart) | `GET /v1/prices/chart?coinId=&days=&currency=` (on-demand proxy) |
| `chart.ts` `getDexOhlcv` (DEX price chart for tokens with no CoinGecko/TradingView chart, e.g. CASHCAT/PONS on Robinhood) | `GET /v1/prices/ohlcv?chainId=&token=&timeframe=&aggregate=&limit=` (on-demand GeckoTerminal proxy, 30s cache, last-good on failure; `COINGECKO_PRO_API_KEY` lifts the rate limit) |
| `dashboard.ts` `getApySnapshot` (StableWatch stable APY) | `GET /v1/stable-apy` — fetched directly from StableWatch as a warmed upstream; the mcp **owns** this data now and no longer depends on the dashboard `/apy` endpoint |
| — (protocol-level, not an app read) | `GET /v1/tvl` — protocol TVL across all supported chains, warmed every 5m from on-chain positions: `tvlUsd` = net user equity (collateral − debt, the DefiLlama TVL), `grossTvlUsd` = total looped collateral, `borrowedUsd` = total debt, plus `positions`/`users`; 503 until the first chain is computed |
| swap/meta-dex aggregators, referral, positions | **out of scope** (execution / backend domains) |

Cross-cutting: `/v1` versioning, CORS limited to `CORS_ORIGINS`, a consistent error envelope
(`{ error: { code, message, correlationId } }`), a correlation id per request (echoed as
`x-correlation-id`), structured JSON logs, and an OpenAPI 3.1 spec at `/openapi.json` (+ committed
`openapi.json`).

---

## Parity gates

1. **`leverage.ts` golden-vector** — `test/golden/leverage.golden.test.ts` freezes fixed inputs →
   exact outputs; `leverage.parity.test.ts` asserts the file is a **byte-for-byte** copy of the
   app's `leverage.ts`. This locks every APY/LTV/ladder number to the app.
2. **`/strategies` composition** — `test/parity/strategies.compose.test.ts` seeds the raw cache
   with a controlled fixture and asserts the composed contract field-by-field (sourcing, LTV math,
   ladder via the verbatim `leverage.ts`, freshness cadences, `null`-vs-absent, `spiralHints`
   isolation). Runs offline in CI.
3. **Live golden-set + app-surface parity** — `scripts/capture-parity.ts` primes the warmer
   against real upstreams and writes the composed `/strategies` (+ apy/borrow histories) for a
   fixed market set to `test/fixtures/`. The parity **diff vs the app** is produced by feeding the
   same fixed inputs to the app's client-side composition and comparing (the app logs its composed
   markets); the PR commits the fixtures and the empty diff. This is the gate that lets us offload
   TVL safely.

---

## Frozen decisions (parity-critical)

- `bignumber.js` pinned to the app's `9.3.1`; **no** global `BigNumber.config` change →
  `toFixed(2)` / rounding (`ROUND_HALF_UP`) identical.
- On-chain reads via **viem** replace wagmi: `getCollateralValueInLoanToken` (multicall3), stUSDS
  `str()`, spUSDG `vsr()` (chain 4663). The app's (intentionally lossy) `BigInt(liqLtv)` from the
  JSON number is matched exactly, not "fixed".
- `maxLeverage = calcLeverage(maxLtv)`; `defaultLeverage = calcLeverage(safeLtv)`,
  `safeLtv = maxLtv% − 0.75` — exactly as the app derives them. Ladder = integer steps
  `1x … ⌊maxLeverage⌋` (LTV `=(1 − 1/lev)·100`) then the exact `max`.
- Exit slippage is baked into `collateralTokens.json` by the app's weekly refresh script; its file
  mtime is the `exitLiquidity.asOf`. The **tier** (the only verdict) lives in `spiralHints` with
  its thresholds; raw `slippagePct` stays under `exitLiquidity`, `null` (no route) preserved.
