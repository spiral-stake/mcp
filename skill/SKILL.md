---
name: spiral-stake
description: >-
  Query Spiral Stake's leveraged-yield ("looping") strategies on Ethereum mainnet — real-time
  collateral/borrow APY, leverage ladders, oracle type, exit-liquidity and liquidation LTVs. Use
  this when a user asks to find, compare, or evaluate leveraged stablecoin / ETH / BTC / PT yield
  strategies, or asks "best strategy", "highest APY loop", "safest leverage", etc.
homepage: https://app.spiralstake.xyz
metadata:
  mcp:
    url: https://api.spiralstake.xyz/mcp
    transport: streamable-http
  data_api: https://api.spiralstake.xyz/v1/strategies
---

# Spiral Stake

Spiral Stake is a **context + execution layer** for leveraged yield ("looping") on Ethereum mainnet,
powered by [Morpho](https://morpho.org). It surfaces every raw cost, leverage step and risk fact;
**you (or the user) decide.** Facts, not verdicts — the only Spiral opinion is namespaced under
`spiralHints` and always ships the thresholds behind it, so you can recompute or override.

## How to connect

- **MCP (preferred):** Streamable-HTTP at `https://api.spiralstake.xyz/mcp`. Tools:
  - `list_strategies({ category? })` — eligible strategies with full raw facts. `category` ∈
    `stable | ETH | BTC | stable-PT | stocks | Other`.
  - `get_strategy({ id })` — one strategy by Morpho market id.
  - `get_prices()` — token USD prices (address → USD).
- **Plain HTTP (no MCP client):** `GET https://api.spiralstake.xyz/v1/strategies` returns the same
  `{ asOf, chainId, count, strategies[] }`. Per-strategy page: `https://app.spiralstake.xyz/1/strategies/{id}/{collateral}-{loan}`.

Only **eligible** strategies are returned — thin/no-swap-route, near-maturity PTs, sub-floor
liquidity and unresolved-APY markets are hidden. Numbers are a snapshot (`asOf`); they move.

## What a strategy is

A one-transaction **leveraged loop**: supply a yield-bearing collateral, borrow against it on Morpho,
recycle the borrow back into more collateral, repeated to a chosen leverage. All strategies here are
**correlated** (collateral and loan track the same value) — leverage multiplies the underlying yield
rather than adding directional price exposure.

## Reading the facts (mechanics, not advice)

- **carry = `collateralApyPct` − `netBorrowApyPct`.** Leverage multiplies this edge. Negative carry
  can still leave a positive `leverageApyPct` (the 1x base yield dominates) — read `leverageLadder`,
  don't infer it.
- **`oracle.type`** decides what can liquidate you. `nav` prices off redemption rate (a DEX depeg
  doesn't move it); `market` prices off the traded price (a depeg can liquidate even if the
  collateral still redeems 1:1). Weigh against `ltvPct.liquidation` headroom, especially on PTs.
- **`exitLiquidity.slippagePct`** is measured per USD size. `null` at a size = no route there;
  a **negative** value = price improvement (not an error).
- **`maxLeverage`** is bounded by available borrow liquidity, not by safety. Higher ladder rungs sit
  closer to `ltvPct.liquidation`.
- **`collateralApySource`**: `none` means no yield source resolved — treat that strategy's APY as
  unknown, not as 0.
- **`freshness`** carries per-group `asOf` + `staleAfterSec`; a stale group is last-good, not dropped.

## Suggested flow for "best strategy"

1. `list_strategies` (optionally by `category`).
2. Rank on the user's goal from raw facts — e.g. risk-adjusted: positive carry, deep exit-liquidity,
   `nav` oracle, comfortable `ltvPct.liquidation` headroom, consistent `historicalLeverageApyPct`.
3. Present the trade-offs and the `spiralHints` opinion (with its thresholds) — let the user choose.
4. Link the strategy page (`links.app`) for review before they act.

Not financial advice; verify current numbers before committing and size for rates flipping against
the position.
