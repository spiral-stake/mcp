// Partner usage attribution — the record that lets us split fees off-chain (the fee itself always
// goes to Spiral's on-chain receiver; who *drove* it is captured here). Emitted on every partner
// build/simulate call, tagged with the partner + the fee-relevant notional so reconciliation against
// on-chain volume is deterministic.
//
// MVP sink = a dedicated structured log line ("partner_usage") shipped to the log platform. The
// single recordUsage() seam means a durable DB/metering sink can be added later without touching any
// caller.
import { log } from "../config/logger.ts";
import type { Partner } from "./registry.ts";

export interface UsageEvent {
  tool: "simulate_leverage" | "build_leverage_tx" | "build_manage_tx";
  chainId: number;
  action: string; // "open_leverage" | close | repay | ...
  userAddress?: string;
  strategyId?: string;
  positionId?: string;
  amountFlashLoan?: string; // loan-token units — the 10 bps fee base
  loanSymbol?: string;
  notionalUsd?: number; // best-effort leveraged position size, for quick rollups
}

export function recordUsage(partner: Partner, event: UsageEvent): void {
  log.info("partner_usage", {
    partnerId: partner.id,
    tier: partner.tier,
    ...event,
    at: new Date().toISOString(),
  });
}
