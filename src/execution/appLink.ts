// Deep-links into the Spiral web app so a user can sign a built transaction in their own wallet
// (the app's existing, audited signing flow) instead of handling the raw payload. Non-custodial: the
// link only prefills inputs; the wallet still holds the key and confirms every action.
import { env } from "../config/env.ts";

const base = () => env.APP_URL.replace(/\/$/, "");
const q = (v: string | number) => encodeURIComponent(String(v));

// Open flow: land on the exact strategy with leverage/amount/pay-token prefilled, ready to sign.
// (`leverage` is the app's query param for the target LTV.)
export function openSigningUrl(
  chainId: number,
  strategyId: string,
  ltv: string,
  amount: string,
  payToken: string,
): string {
  return `${base()}/${chainId}/strategies/${strategyId}?leverage=${q(ltv)}&amount=${q(amount)}&payToken=${q(payToken)}`;
}

// Manage/close flow lives in the portfolio. Deep-link straight to the specific position's card
// (opens its manage panel + scrolls to it). chainId is included because the on-chain position index
// is per-chain — the app only auto-opens when it's on the matching chain, so a stale index can't
// resolve to a different position.
export function portfolioSigningUrl(chainId: number, id: number): string {
  return `${base()}/portfolio?position=${q(id)}&chainId=${q(chainId)}`;
}
