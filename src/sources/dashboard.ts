// Dashboard backend — READ-ONLY upstream (do not modify that service).
// We consume only its `/apy` snapshot (StableWatch-sourced stable APYs + history), exactly as
// the app does via api-services/dashboard.ts::getApySnapshot. Native /apy relocation is a later
// step; for now this is a warmed upstream.
import { env } from "../config/env.ts";
import { getJson } from "./http.ts";

export interface ApySnapshot {
  // Shape is intentionally loose (matches the app's `any` usage). The fields the composition
  // reads: stableApy[].id, .asset, .metrics.apy.avg7d, .history[].
  stableApy?: Array<{
    id?: string;
    asset?: string;
    metrics?: { apy?: { avg7d?: number | string } };
    history?: Array<{ timestamp?: string | number; apy?: number | string }>;
  }>;
  [key: string]: unknown;
}

export async function fetchApySnapshot(): Promise<ApySnapshot> {
  if (!env.DASHBOARD_API_URL) {
    throw new Error("DASHBOARD_API_URL is not configured");
  }
  return getJson<ApySnapshot>(`${env.DASHBOARD_API_URL}/apy`, {
    source: "dashboard",
    retries: 2,
  });
}
