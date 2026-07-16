// Merkl — the single source of truth for borrow incentives: the live (spot) incentive per
// market (from currently-running MORPHOBORROW campaigns) and the daily APR history (charts +
// 30/60/90d windows). Ported from api-services/merkl.ts. localStorage SWR caching is dropped —
// the warmer + RawStore provide that; here we keep pure fetch + the step-function reader.
import { getJson } from "./http.ts";

const MERKL_BASE = "https://api.merkl.xyz";
const MERKL_APP_BASE = "https://app.merkl.xyz";

// apr is already a percentage (e.g. 8.76 → 8.76%); ts is in milliseconds.
export interface MerklAprRecord {
  ts: number;
  apr: number;
}
export type MerklIncentiveHistories = Record<string, MerklAprRecord[]>; // morphoMarketId → merged history

export interface MerklSpotIncentive {
  apy: string; // total live borrow-incentive APR (%), e.g. "6.41"
  breakdown: { symbol: string; apy: string }[];
  url: string; // Merkl opportunity page ("" when unknown)
}
export type MerklSpotIncentives = Record<string, MerklSpotIncentive>; // morphoMarketId → spot

export interface MerklIncentiveData {
  spot: MerklSpotIncentives; // borrow-side (MORPHOBORROW): offsets borrow cost
  collateralSpot: MerklSpotIncentives; // collateral-side (MORPHOCOLLATERAL): adds to collateral yield
  histories: MerklIncentiveHistories; // borrow-side APR history (MORPHOBORROW)
  collateralHistories: MerklIncentiveHistories; // collateral-side APR history (MORPHOCOLLATERAL)
}

interface MerklCampaignMeta {
  id: string;
  opportunityId: string;
  apr: number;
  startMs: number;
  endMs: number;
  rewardSymbol: string;
}

const fetchMerklAprRecords = async (databaseId: string): Promise<MerklAprRecord[]> => {
  const data = await getJson<{ aprRecords?: Array<{ timestamp?: string | number; apr?: string | number }> }>(
    `${MERKL_BASE}/v4/campaigns/${databaseId}/metrics`,
    { source: "merkl", retries: 1 },
  );
  const records = data?.aprRecords ?? [];
  return records
    .map((r) => ({ ts: Number(r.timestamp) * 1000, apr: Number(r.apr) }))
    .filter((r) => isFinite(r.ts) && isFinite(r.apr))
    .sort((a, b) => a.ts - b.ts);
};

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const discoverCampaignsByMarket = async (
  chainId: number,
  opts: { liveOnly?: boolean; type?: "MORPHOBORROW" | "MORPHOCOLLATERAL" } = {},
): Promise<Record<string, MerklCampaignMeta[]>> => {
  const liveOnly = opts.liveOnly ?? false;
  const byMarket: Record<string, MerklCampaignMeta[]> = {};

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      type: opts.type ?? "MORPHOBORROW",
      chainId: String(chainId),
      items: String(PAGE_SIZE),
      page: String(page),
    });
    if (liveOnly) params.set("status", "LIVE");

    const data = await getJson<any[]>(`${MERKL_BASE}/v4/campaigns?${params.toString()}`, {
      source: "merkl",
      timeoutMs: 8000,
    });
    const campaigns = Array.isArray(data) ? data : [];
    for (const c of campaigns) {
      const market = c.params?.market?.toLowerCase();
      if (!market || c.id == null) continue;
      (byMarket[market] ??= []).push({
        id: String(c.id),
        opportunityId: c.opportunityId != null ? String(c.opportunityId) : "",
        apr: Number(c.apr) || 0,
        startMs: Number(c.startTimestamp) * 1000,
        endMs: Number(c.endTimestamp) * 1000,
        rewardSymbol: c.rewardToken?.symbol ?? "?",
      });
    }
    if (campaigns.length < PAGE_SIZE) break;
  }
  return byMarket;
};

const computeSpotIncentives = (
  byMarket: Record<string, MerklCampaignMeta[]>,
  nowMs: number,
): MerklSpotIncentives => {
  const result: MerklSpotIncentives = {};
  for (const [market, campaigns] of Object.entries(byMarket)) {
    const live = campaigns.filter((c) => c.startMs <= nowMs && nowMs < c.endMs && c.apr > 0);
    if (!live.length) continue;

    const aprBySymbol = new Map<string, number>();
    for (const c of live) {
      aprBySymbol.set(c.rewardSymbol, (aprBySymbol.get(c.rewardSymbol) ?? 0) + c.apr);
    }
    const total = [...aprBySymbol.values()].reduce((s, v) => s + v, 0);
    const opportunityId = live.find((c) => c.opportunityId)?.opportunityId;
    result[market] = {
      apy: total.toFixed(2),
      breakdown: [...aprBySymbol.entries()].map(([symbol, apr]) => ({ symbol, apy: apr.toFixed(2) })),
      url: opportunityId ? `${MERKL_APP_BASE}/opportunities/${opportunityId}` : "",
    };
  }
  return result;
};

// Full incentive data: spot (live campaigns) + merged APR history per market. Returns null when
// Merkl returns no campaigns chain-wide (unhealthy source) so the caller keeps last-good.
export const fetchMerklIncentiveData = async (
  chainId: number,
  marketIds: string[],
): Promise<MerklIncentiveData | null> => {
  const wanted = new Set(marketIds.map((id) => id.toLowerCase()));
  // Borrow-side (MORPHOBORROW) and collateral-side (MORPHOCOLLATERAL) campaigns are separate axes:
  // one offsets borrow cost, the other adds to collateral yield. Both are ~1 list call per chain.
  const [byMarket, collByMarket] = await Promise.all([
    discoverCampaignsByMarket(chainId),
    discoverCampaignsByMarket(chainId, { type: "MORPHOCOLLATERAL" }),
  ]);
  // Unhealthy only if Merkl returned nothing on either axis (a chain may legitimately have just one).
  if (Object.keys(byMarket).length === 0 && Object.keys(collByMarket).length === 0) return null;

  const filterWanted = (all: Record<string, MerklCampaignMeta[]>) =>
    Object.fromEntries(Object.entries(all).filter(([market]) => wanted.has(market)));
  const wantedByMarket = filterWanted(byMarket);

  const now = Date.now();
  const spot = computeSpotIncentives(wantedByMarket, now);
  const collateralSpot = computeSpotIncentives(filterWanted(collByMarket), now);

  const wantedCollByMarket = filterWanted(collByMarket);

  const borrowCampaignIds = [
    ...new Set(Object.values(wantedByMarket).flatMap((metas) => metas.map((m) => m.id))),
  ];
  const collateralCampaignIds = [
    ...new Set(Object.values(wantedCollByMarket).flatMap((metas) => metas.map((m) => m.id))),
  ];
  const allCampaignIds = [...new Set([...borrowCampaignIds, ...collateralCampaignIds])];

  if (allCampaignIds.length === 0) return { spot, collateralSpot, histories: {}, collateralHistories: {} };

  const recordsById: Record<string, MerklAprRecord[]> = {};
  await Promise.all(
    allCampaignIds.map(async (id) => {
      try {
        recordsById[id] = await fetchMerklAprRecords(id);
      } catch {
        recordsById[id] = [];
      }
    }),
  );

  const histories: MerklIncentiveHistories = {};
  for (const [market, metas] of Object.entries(wantedByMarket)) {
    if (metas.length) {
      histories[market] = mergeAprRecords(metas.map((m) => recordsById[m.id] ?? []));
    }
  }
  const collateralHistories: MerklIncentiveHistories = {};
  for (const [market, metas] of Object.entries(wantedCollByMarket)) {
    if (metas.length) {
      collateralHistories[market] = mergeAprRecords(metas.map((m) => recordsById[m.id] ?? []));
    }
  }
  return { spot, collateralSpot, histories, collateralHistories };
};

const mergeAprRecords = (histories: MerklAprRecord[][]): MerklAprRecord[] =>
  histories.flat().sort((a, b) => a.ts - b.ts);

const MAX_SNAPSHOT_STALENESS_MS = 2 * 24 * 60 * 60 * 1000;

// Borrow incentive is a step function — constant until the next snapshot. Returns the APR (%)
// active at tsMs, or 0 before the first / well after the last snapshot.
export const incentiveAprAt = (history: MerklAprRecord[], tsMs: number): number => {
  if (!history.length || tsMs < history[0].ts) return 0;
  let lo = 0;
  let hi = history.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (history[mid].ts <= tsMs) lo = mid;
    else hi = mid - 1;
  }
  if (tsMs - history[lo].ts > MAX_SNAPSHOT_STALENESS_MS) return 0;
  return history[lo].apr;
};
