# Spiral Stake — Partner Integration API

Embed leveraged-yield strategies into your app. Spiral is **non-custodial**: these endpoints return
**unsigned transactions** your user signs in their own wallet. The API never signs, sends, or holds
keys — you keep full custody of the signing step.

- **Base URL:** `https://api.spiralstake.xyz`
- **Auth:** `Authorization: Bearer <your-api-key>` on every partner endpoint.
- **Chains:** `chainId` 1 (Ethereum, default) or 4663 (Robinhood Chain).
- **Content type:** `application/json`.

Keys are issued out-of-band. Keep them server-side; never ship a key to a browser/client.

## Flow

1. **Discover** — read strategies + risk facts (public, no key needed):
   `GET /v1/strategies?chainId=1`
2. **Preview** — deterministic position preview, no wallet:
   `POST /v1/partner/leverage/simulate`
3. **Build** — get the unsigned approvals + transaction for a user to sign:
   `POST /v1/partner/leverage/build`
4. **User signs** — send `approvals[]` first (if any), then `tx`, from the user's wallet. Or hand
   them `meta.signingUrl` to review + sign in the Spiral app.
5. **Manage / close** — adjust or unwind a position:
   `POST /v1/partner/manage/build`

## Endpoints

### `POST /v1/partner/leverage/simulate`
```json
{ "strategyId": "0x…", "payToken": "0x…", "amount": "10000", "leverage": 3, "chainId": 1 }
```
Returns `{ path, positionPreview{leverage, effectiveLtv, expectedLeverageApy, priceImpactPct}, amountFlashLoan, … }`.
Provide `leverage` OR `desiredLtv`. `payToken` may be the collateral (opened directly) or any other
token (zapped to collateral first); native ETH = the zero address.

### `POST /v1/partner/leverage/build`
Same body **plus** `userAddress` (the wallet that will sign):
```json
{ "strategyId": "0x…", "payToken": "0x…", "amount": "10000", "leverage": 3, "userAddress": "0x…", "chainId": 1 }
```
Returns:
```json
{
  "path": "leverage",
  "approvals": [ { "to": "0x…", "data": "0x…" } ],
  "tx": { "to": "0x…", "data": "0x…", "value": "0" },
  "meta": { "positionPreview": { … }, "amountFlashLoan": "…", "minTokenOut": "…",
            "expiresAt": "…", "signingUrl": "https://app.spiralstake.xyz/…" }
}
```
Send the `approvals` first, then `tx`. **`meta.expiresAt`** — the embedded swap calldata is
time-sensitive (~60s); rebuild if it lapses before signing.

### `POST /v1/partner/manage/build`
```json
{ "userAddress": "0x…", "id": 0, "action": "close", "chainId": 1 }
```
`action` ∈ `close` · `increase_leverage` · `add_collateral` · `remove_collateral` · `repay` · `borrow`.
`add_collateral` and `repay` take `payToken` + `amount`; `repay` accepts `full: true` to clear the debt.

### `GET /v1/partner/positions/{address}?chainId=1`
A wallet's open/closed positions — read-only. Each carries `id` (the on-chain index, feeds
`/manage/build`), `positionId` (`${chainId}-${strategyId}-${id}`, globally unique), collateral/debt,
current vs liquidation LTV, leverage, net value, and live APY.

## Errors
Standard envelope: `{ "error": { "code", "message", "correlationId" } }`.
- `401 unauthorized` — missing/invalid key.
- `400 bad_request` — invalid input (bad chain, missing field, unknown strategy).
- `503 upstream_unavailable` — transient (market data too stale, no swap route, RPC) — retry.
- `429` — rate limit; honor `Retry-After`.

Quote the `correlationId` to support for any issue.

## Notes
- **Non-custodial:** you never send us a private key; we never send funds. The `tx` must be signed
  by the `userAddress` it was built for.
- **Fees:** a swap fee is embedded on the input token — 5 bps on correlated markets, 25 bps on
  non-correlated markets; partner revenue share is reconciled separately per your agreement.
- **Rate limits:** per-partner, returned as `RateLimit-*` headers.
- **Slippage:** default 0.5%, capped at 1%; override with `slippage` (ratio, e.g. `0.003`).
