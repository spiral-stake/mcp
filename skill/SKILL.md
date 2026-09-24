---
name: spiral-stake
description: >-
  Query and execute Spiral Stake's leveraged strategies on Ethereum mainnet and Robinhood Chain —
  leveraged stablecoin / ETH / BTC / Pendle-PT yield loops, directional perps, and stock + yield
  equity vaults on tokenized stocks — with real-time collateral/borrow APY, leverage ladders, oracle
  type, exit liquidity, liquidation LTVs, live positions, and unsigned transactions for the user's
  own wallet. Use this when a user asks to find, compare, evaluate, open, manage or close a leveraged
  yield or stock strategy, or asks "best strategy", "highest APY loop", "safest leverage", "long a
  stock and earn yield", etc.
homepage: https://app.spiralstake.xyz
metadata:
  mcp:
    url: https://api.spiralstake.xyz/mcp
    transport: streamable-http
  data_api: https://api.spiralstake.xyz/v1/strategies
---

# Spiral Stake

Spiral Stake is a **context + execution layer** for leverage on [Morpho](https://morpho.org), on
**Ethereum mainnet (chainId 1)** and **Robinhood Chain (chainId 4663)**. It surfaces every raw cost,
leverage step and risk fact, and builds the transactions; **you (or the user) decide and sign.**
Facts, not verdicts — the only Spiral opinion is namespaced under `spiralHints` and always ships the
thresholds behind it, so you can recompute or override. Non-custodial: the server never signs, sends,
or holds keys.

## How to connect

- **MCP (preferred):** Streamable-HTTP at `https://api.spiralstake.xyz/mcp`. Every tool takes an
  optional `chainId` (default 1). Tools:
  - `list_strategies({ category?, chainId? })` — eligible strategies with full raw facts. `category` ∈
    `stable | ETH | BTC | stable-PT | stocks | Other`.
  - `get_strategy({ id, chainId? })` — one strategy by id.
  - `get_prices({ chainId? })` — USD prices of the chain's loan and collateral tokens (address → USD).
  - `get_positions({ userAddress, chainId? })` — a wallet's loop positions (`positions`) and open
    equity vaults (`equityPositions`), from chain state.
  - `simulate_leverage` / `build_leverage_tx` / `build_manage_tx` — preview, open, adjust or close a
    leveraged loop or perp position (unsigned `{ approvals[], tx }` for the user's wallet).
  - `simulate_equity_deposit` / `build_equity_deposit_tx` / `build_equity_exit_tx` — preview, enter
    or fully unwind a stock + yield equity vault (unsigned atomic `calls[]` batch).
- **Plain HTTP (no MCP client):** `GET https://api.spiralstake.xyz/v1/strategies?chainId=4663`
  returns the same `{ asOf, chainId, count, strategies[] }`. Per-strategy page:
  `links.app` on each strategy (`https://app.spiralstake.xyz/{chainId}/strategies/{id}/{collateral}-{loan}`).

Only **eligible** strategies are returned — no-swap-route, near-maturity PTs, sub-floor liquidity
(mainnet) and unresolved-APY loops are hidden. Numbers are a snapshot (`asOf`); they move.

## The three strategy profiles

1. **Correlated yield loop** (`correlated: true`, no `spiralHints.profile`) — supply a yield-bearing
   collateral, borrow a correlated loan token against it, recycle to a chosen leverage. Leverage
   multiplies the yield; there is no directional price exposure. Mainnet: stables, ETH, BTC, PTs.
   Robinhood: spUSDG / syrupUSDG / USDe against USDG.
2. **Directional perp** (`correlated: false`, `spiralHints.profile.value = "leveraged_perp"`, Robinhood
   only) — a leveraged long on a token (PONS, CASHCAT). **Every `leverageApyPct` is financing carry
   only** (collateral yield − borrow cost, × leverage), typically negative; the collateral's price
   move, which dominates P&L, is not in it. Liquidates when the price falls to `ltvPct.liquidation`.
3. **Equity vault** (`id` starts with `equity-`, `collateral.category = "stocks"`,
   `spiralHints.profile.value = "equity_yield_vault"`, Robinhood only) — deposit USDG; it is swapped to
   a tokenized stock (SPY, NVDA, TSLA, SPCX, AAPL) held as the user's own collateral on a partner
   market (`curator`: Longbow or NetNet Credit), a share of its value is borrowed back and farmed in a
   Spiral yield loop. **You stay 1x long the stock**; `leverageApyPct` is the net dollar APY on the
   deposit at the default stock LTV, not a user-selectable leverage. Two vaults can share a ticker
   (Longbow's NVDA vs NetNet's) — tell them apart by `curator` and `collateral.description`.

## Reading the facts (mechanics, not advice)

- **carry = `collateralApyPct` + `collateralIncentive.aprPct` − `netBorrowApyPct`.** Leverage multiplies
  this edge. Negative carry can still leave a positive `leverageApyPct` (the 1x base yield dominates) —
  read `leverageLadder`, don't infer it.
- **`oracle.type`** decides what can liquidate you. `nav` prices off redemption rate (a DEX depeg
  doesn't move it); `market` prices off a traded feed (a price fall liquidates — every perp and every
  stock vault is `market`). Weigh against `ltvPct.liquidation` headroom, especially on PTs and perps.
- **`exitLiquidity.slippagePct`** is measured per USD size, selling the collateral into the chain's
  stable (`direction`). `null` at a size = no route there; a **negative** value = price improvement.
  A vault's exit liquidity is its stock's. `spiralHints.exitLiquidityTier` grades it with its thresholds.
- **`maxLeverage`** is bounded by available borrow liquidity, not by safety. Higher ladder rungs sit
  closer to `ltvPct.liquidation`. Robinhood markets are young: some perps list with very little
  borrowable liquidity (`liquidityUsd`) — an open bigger than that reverts.
- **`collateralApySource`**: `none` means no yield source resolved — treat that APY as unknown, not 0.
- **`freshness`** carries per-group `asOf` + `staleAfterSec`; a stale group is last-good, not dropped.
- **`links.market`** is the market's own page (Morpho, longbow.cash or NetNet Credit).

## Suggested flow for "best strategy"

1. `list_strategies` on the chain(s) the user can use, optionally by `category`.
2. Rank on the user's goal from raw facts — e.g. risk-adjusted: positive carry, deep exit liquidity,
   `nav` oracle, comfortable `ltvPct.liquidation` headroom, consistent `historicalLeverageApyPct`,
   enough `liquidityUsd` for the size.
3. Present the trade-offs and the `spiralHints` opinion (with its thresholds) — let the user choose.
4. `simulate_leverage` (or `simulate_equity_deposit`) at the user's size before building anything;
   the preview carries the effective LTV, expected APY and price impact. Then `build_*` for the
   user's wallet, and let them sign (`meta.signingUrl` opens the app pre-filled).

## Executing safely

- Always simulate first, and rebuild if `meta.expiresAt` has passed — swap calldata is time-sensitive.
- Loop bundles are `{ approvals[], tx }`: approvals first, then `tx`. Equity bundles are an ordered
  `calls[]` with `atomic: true`: submit as one batch (EIP-5792 `wallet_sendCalls` / Safe MultiSend);
  a wallet that cannot batch sends them in order and must always send the final (revoke) call.
- A vault's yield loop cannot be managed alone (`build_manage_tx` refuses it) — unwind the whole
  vault with `build_equity_exit_tx`.
- An aggregator outage is reported as transient ("temporarily unavailable" / "rate-limited: … retry
  in a few seconds"); "route not found" is not.

Not financial advice; verify current numbers before committing and size for rates flipping against
the position.
