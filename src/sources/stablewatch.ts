// Direct StableWatch source — the mcp owns its stable-APY data and no longer depends on the
// dashboard `/apy` endpoint (that responsibility now lives here). Ported verbatim (logic) from
// v2-dashboard/server/jobs/updateApy.js so the produced `stableApy` shape is byte-for-byte what
// the dashboard served, keeping app parity intact.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.ts";
import { getJson } from "./http.ts";

const here = dirname(fileURLToPath(import.meta.url));
const STABLEWATCH_IDS = new Set(
  (JSON.parse(readFileSync(resolve(here, "../data/stablewatch-ids.json"), "utf8")) as string[]).map(
    (id) => id.toLowerCase(),
  ),
);

const BASE = "https://api.stablewatch.io/api";

interface Pool {
  id: string;
  asset?: string;
  metrics?: { apy?: { avg7d?: number } };
}
interface HistoryPoint {
  timestamp?: string | number;
  apy?: number;
}

// Shape consumed by the composition (core/apy.ts): stableApy[].id, .asset, .metrics.apy.avg7d,
// .history[]. Intentionally identical to the dashboard's /apy `stableApy` field.
export interface ApySnapshot {
  stableApy?: Array<{
    id?: string;
    asset?: string;
    metrics?: { apy?: { avg7d?: number | string } };
    history?: Array<{ timestamp?: string | number; apy?: number | string }>;
  }>;
  [key: string]: unknown;
}

export async function fetchStablewatchApy(): Promise<ApySnapshot> {
  const key = env.STABLEWATCH_API_KEY;
  if (!key) throw new Error("STABLEWATCH_API_KEY is not configured");

  const poolsBody = await getJson<{ data: Pool[] }>(`${BASE}/pools?api_key=${key}`, {
    source: "stablewatch",
    retries: 2,
  });
  const relevantPools = (poolsBody.data ?? []).filter((p) => STABLEWATCH_IDS.has(p.id.toLowerCase()));

  const historyResults = await Promise.all(
    relevantPools.map((p) =>
      getJson<{ data: { data: HistoryPoint[] } }>(`${BASE}/history/${p.id}?api_key=${key}`, {
        source: "stablewatch-history",
        retries: 2,
      })
        .then((r) => [p.id.toLowerCase(), r.data?.data ?? []] as const)
        .catch(() => [p.id.toLowerCase(), [] as HistoryPoint[]] as const),
    ),
  );

  const historyMap = Object.fromEntries(historyResults);
  const stableApy = relevantPools.map((p) => {
    const history = (historyMap[p.id.toLowerCase()] ?? []).map(({ timestamp, apy }) => ({ timestamp, apy }));
    let avg7d = p.metrics?.apy?.avg7d;
    if (!avg7d) {
      const recent = history.filter((h) => (h.apy ?? 0) > 0).slice(-7);
      avg7d = recent.length ? recent.reduce((s, h) => s + (h.apy ?? 0), 0) / recent.length : 0;
    }
    return { id: p.id, asset: p.asset, metrics: { apy: { avg7d } }, history };
  });

  return { stableApy };
}
