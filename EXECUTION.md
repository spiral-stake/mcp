# Execution (C) — frozen contract (v1)

The design C2–C5 build against. **The mcp never signs or sends — it emits unsigned transactions the
agent's wallet approves.** Money-path equivalent of `CONTRACT.md`.

## Invariants (non-negotiable)
1. **Non-custodial.** Tools return **unsigned** txs (`{to, data, value}`). No keys, no `writeContract`,
   no signing, no `sendTransaction` in the mcp — ever. (Enforced by a test.)
2. **Simulate-first.** `build_leverage_tx` embeds a fresh simulation; a reverting build is refused.
3. **Parity-gated.** Built calldata/params must be **byte-identical** to the app's open flow
   (`StrategyPage.tsx:242–449`) for the same inputs. The fund-safety gate for C2.
4. **Fail-closed.** Refuse to build on stale data (H3 freshness), a reverting simulation, missing USD
   prices, `slippage > MAX_SLIPPAGE`, amount ≤ 0, or a non-`visible` strategy.
5. **Reuse, don't reinvent.** Port the app's pure builders; only replace "send via wallet" with
   "return unsigned tx."

## v1 scope — the FULL open flow, path chosen in the background (identical to the app)

The agent supplies **any** `tokenIn` + amount + leverage; the mcp selects the same path the app does.
**All four variants are in scope for v1.**

```
isDirect     = tokenIn == collateralToken
isReallocate = market.liquidityAssetsParsed <= amountFlashLoan

                        normal (liquidity ok)                 reallocate (liquidity short)
 direct (tokenIn==col)  FlashLeverage.leverage                FlashLeverageRouter.reallocateAndLeverage
 router (tokenIn!=col)  FlashLeverageRouter.swapAndLeverage   FlashLeverageRouter.reallocateSwapAndLeverage
```

**Out of scope (v1):** manage/close (`increaseLeverage`, `deleverage`, `supplyCollateral`, `repay`,
`withdrawCollateral`, `borrow`) — separately-reviewed follow-ons.

## The open mechanics (mapped — the background decision tree)

Given `(strategyId, tokenIn, amountIn, leverage|desiredLtv, userAddress, slippage)`:

1. `desiredLtv` from `leverage` (inverse of `calcLeverage`), or accept `desiredLtv`.
2. **If router** (`tokenIn != collateral`): pre-swap `tokenIn → collateral`
   `getSwapData(chainId, isPt, receiver=routerAddr, tokenIn, collateral, parseUnits(amountIn), slippage)`
   → `externalSwapData = { swapData, minTokenOut = amountOut×(1−slippage) }`;
   `amountCollateral(for flash-loan)` = the swapped-out collateral amount.
   **If direct:** `amountCollateral = amountIn`.
3. `amountFlashLoan = calcFlashLoanAmount(desiredLtv, market, amountCollateral)` (loan-token units).
4. Leverage swap (`borrow → collateral`)
   `getSwapData(chainId, isPt, receiver=(direct?flashLeverage:router), loanToken, collateral, amountFlashLoan, slippage)`
   → `swapData`, `amountOut`, `priceImpact`; `minTokenOut = amountOut×(1−slippage)` (BigInt, ROUND_DOWN).
   - **PT collateral:** `getSwapData` routes via the **Pendle SDK** and charges the market's fee
     (**5 bps** correlated / **25 bps** non-correlated) on `currency_in` — this must be ported exactly
     (see the Pendle fee-collection path).
   - **Prices missing** (`tokenIn`/collateral `valueInUsd == 0`) → **refuse** (the app toasts + reloads).
5. `leverageParams = { marketId, amountCollateral: (direct ? parseUnits(amountIn, collateral.dec)
   : externalSwapData.minTokenOut), amountFlashLoan, swapData, minTokenOut }`.
   *(Router path uses the pre-swap's `minTokenOut` as `amountCollateral` — StrategyPage:405–407.)*
6. **Reallocate?** `isReallocate = liquidityAssetsParsed <= amountFlashLoan`.
   If so: `{ params: reallocateParams, totalFee } = buildReallocateParams(chainId, market, amountFlashLoan)`.
7. **Value:** `ethValue = (tokenIn==ETH) ? parseUnits(amountIn, 18) : 0n`;
   `reallocateEthValue = ethValue + totalFee`.
8. **Approvals** (ERC-20 `tokenIn` only): `ERC20.approveCalls(spender, amountIn)` where
   `spender = isDirect ? flashLeverage : router`. Allowance-aware; **USDT** gets the reset-to-0 dance.
9. **Encode** the selected method → unsigned tx (`to` = FlashLeverage for direct+normal, else the Router):

   | variant | method(args) | value |
   |---|---|---|
   | direct + normal | `leverage(userAddress, leverageParams)` | `ethValue` |
   | router + normal | `swapAndLeverage(tokenIn, parseUnits(amountIn), externalSwapData.swapData, externalSwapData.minTokenOut, leverageParams)` | `ethValue` |
   | direct + reallocate | `reallocateAndLeverage(reallocateParams, leverageParams)` | `reallocateEthValue` |
   | router + reallocate | `reallocateSwapAndLeverage(reallocateParams, tokenIn, parseUnits(amountIn), externalSwapData.swapData, externalSwapData.minTokenOut, leverageParams)` | `reallocateEthValue` |

10. **Simulate:** viem `simulateContract`/`eth_call` from `userAddress` → revert reason or success.

Slippage bounded (default 0.5%, hard cap = contract `MAX_SLIPPAGE` 1%).

## Tool surface (v1)

| Tool | Args | Returns | Class |
|---|---|---|---|
| `simulate_leverage` | `{ strategyId, tokenIn, amountIn, leverage?, desiredLtv?, userAddress, slippage? }` | `{ path, leverage, ltvPct, liquidationPrice, expectedLeverageApyPct, amountLeveragedCollateral, amountFlashLoan, minTokenOut, priceImpactPct, reallocateFee, healthOk, revertReason? }` | read-only |
| `build_leverage_tx` | same | `UnsignedTxBundle` (below) | **build** (auth TBD) |
| `get_positions` | `{ userAddress }` | open positions `{ leverage, ltv, liquidationPrice, healthFactor, yieldGenerated }` | read-only |

## Unsigned-tx response contract

```jsonc
{
  "chainId": 1,
  "action": "open_leverage",
  "path": "direct_normal | router_normal | direct_reallocate | router_reallocate",
  "approvals": [ { "to": "0xTOKENIN", "data": "0x095ea7b3…", "value": "0",
                   "meta": { "token": "sUSDS", "spender": "0x…", "amount": "…" } } ],  // ERC-20 tokenIn, if allowance short
  "tx": { "to": "0xFLASHLEVERAGE_or_ROUTER", "data": "0x…", "value": "0" },            // value carries ETH collateral + reallocate fees
  "simulation": { "ok": true, "revertReason": null },
  "meta": {
    "strategyId": "0x…", "userAddress": "0x…", "tokenIn": "0x…",
    "amountIn": "1000", "leverage": "5.0", "desiredLtvPct": "80.0",
    "amountFlashLoan": "…", "minTokenOut": "…", "slippage": "0.005",
    "reallocateFee": "0", "priceImpactPct": "…",
    "positionPreview": { "liquidationPrice": "…", "expectedLeverageApyPct": "…", "amountLeveragedCollateral": "…" },
    "expiresAt": "<ISO — swap calldata is time-sensitive; rebuild after this>",
    "instructions": "Sign the approval(s) if present, then the tx, in your wallet. Spiral never holds your funds."
  }
}
```
- Amounts = decimal strings; addresses checksummed. `approvals` execute **before** `tx` (client batches
  via EIP-5792 or runs sequentially — mirrors the app's `writes([...approveCalls, actionCall])`).
- `expiresAt` short (routes go stale) → re-`build` after it.

## Shared-logic / port surface (C2)
Port the **pure** builders; do **not** port `Base.write`/`writes`/wagmi. Reads that used
`getAccount(wagmiConfig)` become viem reads with the passed `userAddress`.
- `calcFlashLoanAmount` (already via `leverage.ts`), path selection, `minTokenOut`, ETH/fee value math.
- **`getSwapData`** — KyberSwap (non-PT) + **Pendle SDK** (PT), w/ the per-market fee (5 / 25 bps). Biggest piece; fund-relevant.
- **`buildReallocateParams`** (`utils/publicAllocator.ts`) — public-allocator withdrawals + `totalFee`.
- **`ERC20.approveCalls`** — viem `allowance` + USDT reset-to-0 special-case.
- **ABIs + addresses:** `FlashLeverage` + `FlashLeverageRouter`, via extended `sync:data`.
- `encodeFunctionData` (viem, already a dep) for the 5 methods.

## Parity gate (C2 definition of done)
Byte-identical `{ approvals, tx.to, tx.data, tx.value }` + `leverageParams`/`reallocateParams` vs the
app, across a fixture matrix covering **all 4 variants × ETH & ERC-20 tokenIn × PT & non-PT collateral**.
KyberSwap/Pendle route bytes are time-variant → compare structurally (router, tokenIn/out, amountIn,
minTokenOut, fee) + the method-arg encoding. Committed fixtures + diff, like the composition parity.

## Guardrails (C4)
Refuse if: any consumed group is stale (H3), simulation reverts, USD prices missing,
`slippage > MAX_SLIPPAGE`, amount ≤ 0, or strategy not `visible`. `minTokenOut` sanity vs the
strategy's exit-liquidity/price-impact. Explicit risk + non-custodial disclosure in every `build`.
Full `/security-review` of the money path before C5 ships.

## Decisions
1. **v1 scope = full open (all 4 variants, auto-selected by `tokenIn` + liquidity).** ✅ confirmed.
2. **Approvals:** emit `approvals[]` + `tx`; client batches (5792) or sequential — mirrors the app. ✅ confirmed.
3. **Auth on `build_leverage_tx`:** ⏳ pending (user to specify). Until then, treat as consent-gated
   (explicit framing, non-custodial), no server auth.
