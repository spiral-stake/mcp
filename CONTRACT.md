# `/strategies` — frozen response contract (v1)

The single contract the `../mcp` service produces and both the app (llms.txt/JSON-LD/prerender/data reads) and MCP tools consume. **Facts, not verdicts.** Every number is raw + unit-labeled; any Spiral opinion is optional, namespaced, and carries its thresholds so an agent can override it. Per-field-group freshness (data classes refresh at different cadences).

## Conventions
- APYs/percentages: **strings**, 2-dp (matches BigNumber `toFixed(2)`), suffix `Pct`. USD amounts: numbers, suffix `Usd`.
- `null` = measured, no value (e.g. no swap route at size). Field **absent** = not measured — an agent must treat as unknown, **not** safe.
- A **negative** `slippagePct` is price improvement (you receive more than you put in), not an error.
- Timestamps: ISO-8601 UTC.

## Refresh cadence (producer)
| Data class | Cadence | `staleAfterSec` |
|---|---|---|
| Borrow APY + liquidity (Morpho) | ~2 min warmer | 300 |
| Collateral APY — **non-PT** (StableWatch, DeFiLlama, Royco, on-chain) | 12 h | 43200 |
| Collateral APY — **Pendle PT** (implied APY) | 30 min | 1800 |
| Exit slippage (`refresh:liquidity`) | 12 h | 86400 (one-cycle grace) |

## Frozen decisions
- **Leverage ladder** = integer steps `1x, 2x, 3x, …` then always append the exact `max`. Variable length.
- **`spiralHints`** ships in v1 but is a **separate, namespaced block** — never interleaved with raw facts; always carries its thresholds. Raw `exitSlippage*` are facts and live in `exitLiquidity.slippagePct`; the *tier* is the only opinion, and it sits in `spiralHints`.

## Envelope
```jsonc
{
  "asOf": "2026-07-06T12:00:00Z",   // snapshot assembly time
  "chainId": 1,
  "count": 87,
  "strategies": [ /* Strategy[] */ ]
}
```

## Strategy
```jsonc
{
  "id": "0xMORPHO_MARKET_ID",
  "chainId": 1,
  "correlated": true,                 // collateral↔loan correlated (leverage-relevant fact)

  "collateral": {
    "address": "0x…", "symbol": "sUSDe", "name": "…", "decimals": 18,
    "category": "stable",             // stable | ETH | BTC | stable-PT | stocks | Nest RWA | Other
    "project": "Ethena", "yieldSource": "funding basis",
    "priceUsd": 1.001,
    "isPt": false,
    "maturity": null, "maturityDate": null, "maturityDaysLeft": null,   // fixed-term facts
    "underlying": { "address": "0x…", "symbol": "USDe" }                 // when applicable
  },
  "loan": { "address": "0x…", "symbol": "USDC", "decimals": 6, "priceUsd": 1.0 },

  // ── yield facts (raw) ──
  "collateralApyPct": "9.12",
  "collateralApySource": "stablewatch",     // pendle|defillama|royco|stablewatch|onchain
  "yieldSustainabilityPct": { "avg30d": "8.90", "avg60d": "9.05", "avg90d": "8.70" },

  // ── borrow facts (raw) ──
  "borrowApyPct": "4.20",
  "quarterlyBorrowApyPct": "4.05",
  "borrowIncentive": {
    "aprPct": "1.10",
    "breakdown": [ { "symbol": "DOLA", "aprPct": "1.10" } ],
    "campaignUrl": "https://app.merkl.xyz/…",   // absent when none
    "endsAt": "2026-08-01T00:00:00Z"            // incentive-decay context; absent if unknown
  },
  "netBorrowApyPct": "3.10",                    // borrowApy − incentive (labeled, raw)

  // ── capacity facts (raw) ──
  "supplyUsd": 12000000,
  "liquidityUsd": 3400000,
  "publicAllocatorLiquidityUsd": 5100000,       // combined PA-shared depth (drives max leverage)
  "maxLeverage": "5.4",
  "utilizationPct": "71.2",                     // absent if not derivable

  // ── leverage ladder (NEW — agent context without round-trips) ──
  // Discrete points 1x → max; apy computed by the same leverage.ts the app uses live.
  "leverageLadder": [
    { "leverage": "1.0", "ltvPct": "0.0",  "leverageApyPct": "9.12" },
    { "leverage": "2.0", "ltvPct": "50.0", "leverageApyPct": "14.14" },
    { "leverage": "3.0", "ltvPct": "66.7", "leverageApyPct": "18.94" },
    { "leverage": "5.4", "ltvPct": "81.5", "leverageApyPct": "35.62" }   // = maxLeverage
  ],
  "defaultLeverage": { "leverage": "3.0", "ltvPct": "66.7", "leverageApyPct": "18.94" },
  "historicalLeverageApyPct": { "avg30d": "18.10", "avg60d": "18.55", "avg90d": "17.80" },

  // ── risk facts (raw, NO verdicts) ──
  "ltvPct": { "liquidation": "86.0", "max": "77.0" },     // liqLtv / maxLtv
  "oracle": {
    "address": "0x…",
    "type": "nav",                    // nav | market — mechanism fact, not "safe/unsafe"
    "provider": "…", "heartbeatSec": 86400, "deviationPct": "0.5", "hardcodedCap": null  // when known
  },
  "exitLiquidity": {                  // field-shape contract (from exitLiquidity.ts discussion)
    "measured": true,
    "asOf": "2026-07-06T06:00:00Z",
    "method": "onchain quote sweep",
    "direction": "collateral_to_usdc",
    "slippagePct": { "100000": "0.01", "500000": "0.05", "1000000": "0.05", "5000000": "0.13" }
    // raw facts; a size is `null` when there is no route at that notional
  },
  "noSwapRoute": false,

  // ── OPTIONAL Spiral opinion — namespaced + overridable; agent may ignore ──
  "spiralHints": {
    "exitLiquidityTier": { "value": "good", "thresholds": { "listingMaxPct": 2, "depthCleanMaxPct": 1.5 } }
  },

  // ── per-field-group freshness (data classes refresh at different cadences) ──
  "freshness": {
    "borrow":        { "asOf": "2026-07-06T12:00:00Z", "staleAfterSec": 300   },  // Morpho warmer ~2m
    "collateralApy": { "asOf": "2026-07-06T00:00:00Z", "staleAfterSec": 43200 },  // 12h; Pendle PT: 1800 (30m)
    "exitLiquidity": { "asOf": "2026-07-06T06:00:00Z", "staleAfterSec": 86400 }   // 12h refresh, 24h grace
  },

  "links": { "app": "https://…/strategy/…", "market": "https://…", "yieldSource": "https://…" }
}
```

## Rules for the producer (`../mcp`)
1. Never emit a verdict outside `spiralHints`; `spiralHints` always ships its thresholds.
2. Preserve `null` vs absent semantics exactly — never coerce “no route” into a tier or a 0.
3. Every field-group in `freshness` carries its own `asOf`; a group past `staleAfterSec` is served **last-good** (never dropped, never 0) and the stale age is visible.
4. `leverageLadder` + all APYs use the **copied `leverage.ts`**, locked to the app by the golden-vector test.
5. Additive-only evolution; breaking changes bump the version.
