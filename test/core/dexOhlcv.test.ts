// core/dexOhlcv — the rate-limit budget guard for the perp price charts. GeckoTerminal's public API
// allows ~30 req/min, so these prove that N viewers cost ~1 upstream call per 30s, that a burst
// coalesces, and that an upstream failure degrades to last-good instead of a blank chart.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchTopPool, fetchPoolOhlcv } = vi.hoisted(() => ({ fetchTopPool: vi.fn(), fetchPoolOhlcv: vi.fn() }));

vi.mock("../../src/sources/geckoterminal.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sources/geckoterminal.ts")>();
  return { ...actual, fetchTopPool, fetchPoolOhlcv };
});

import { getDexOhlcv, NoPoolError, _resetDexOhlcvCaches, CANDLES_TTL_MS, CANDLES_STALE_GRACE_MS } from "../../src/core/dexOhlcv.ts";

const TOKEN = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
const POOL = { address: "0xd42a491087a15e5afd51feb3606066cc152d2b09", name: "CASHCAT / WETH 0.3%", dex: "uniswap-v3-robinhood", reserveUsd: 3e6, tokenSide: "base" as const };
const CANDLES = [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }];
const req = { chainId: 4663, token: TOKEN, timeframe: "hour" as const, aggregate: 1, limit: 24 };

describe("core/dexOhlcv", () => {
  beforeEach(() => {
    _resetDexOhlcvCaches();
    fetchTopPool.mockReset().mockResolvedValue(POOL);
    fetchPoolOhlcv.mockReset().mockResolvedValue(CANDLES);
    vi.useRealTimers();
  });

  it("serves from cache within the 30s TTL and refetches after it", async () => {
    vi.useFakeTimers();
    const a = await getDexOhlcv(req);
    expect(a.candles).toEqual(CANDLES);
    expect(a.stale).toBe(false);
    expect(a.pool).toEqual({ address: POOL.address, name: POOL.name, dex: POOL.dex });

    await getDexOhlcv(req);
    await getDexOhlcv(req);
    expect(fetchPoolOhlcv).toHaveBeenCalledTimes(1);
    expect(fetchTopPool).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CANDLES_TTL_MS.hour + 1);
    await getDexOhlcv(req);
    expect(fetchPoolOhlcv).toHaveBeenCalledTimes(2);
    // Pool resolution is cached for an hour — the refetch must not re-resolve it.
    expect(fetchTopPool).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of identical requests into one upstream call", async () => {
    let release!: (v: typeof CANDLES) => void;
    fetchPoolOhlcv.mockReturnValueOnce(new Promise((r) => (release = r)));
    const burst = Promise.all([getDexOhlcv(req), getDexOhlcv(req), getDexOhlcv(req)]);
    await Promise.resolve(); // let the first call reach upstream
    release(CANDLES);
    const results = await burst;
    expect(results.every((r) => r.candles === CANDLES)).toBe(true);
    expect(fetchPoolOhlcv).toHaveBeenCalledTimes(1);
  });

  it("keys the cache on every request dimension", async () => {
    await getDexOhlcv(req);
    await getDexOhlcv({ ...req, timeframe: "day", aggregate: 1 });
    await getDexOhlcv({ ...req, limit: 48 });
    expect(fetchPoolOhlcv).toHaveBeenCalledTimes(3);
    expect(fetchTopPool).toHaveBeenCalledTimes(1); // same token → one pool lookup
  });

  it("serves last-good flagged stale when upstream fails inside the grace window, then fails past it", async () => {
    vi.useFakeTimers();
    await getDexOhlcv(req);

    vi.advanceTimersByTime(CANDLES_TTL_MS.hour + 1);
    fetchPoolOhlcv.mockRejectedValueOnce(new Error("HTTP 429 from geckoterminal"));
    const stale = await getDexOhlcv(req);
    expect(stale.stale).toBe(true);
    expect(stale.candles).toEqual(CANDLES);

    vi.advanceTimersByTime(CANDLES_STALE_GRACE_MS.hour + 1);
    fetchPoolOhlcv.mockRejectedValueOnce(new Error("HTTP 429 from geckoterminal"));
    await expect(getDexOhlcv(req)).rejects.toThrow(/429/);
  });

  it("surfaces an unlisted token as NoPoolError and negative-caches it (no upstream hammering)", async () => {
    fetchTopPool.mockResolvedValue(null);
    await expect(getDexOhlcv(req)).rejects.toBeInstanceOf(NoPoolError);
    await expect(getDexOhlcv(req)).rejects.toBeInstanceOf(NoPoolError);
    expect(fetchTopPool).toHaveBeenCalledTimes(1);
    expect(fetchPoolOhlcv).not.toHaveBeenCalled();
  });

  it("never masks a missing pool with stale candles", async () => {
    vi.useFakeTimers();
    await getDexOhlcv(req);
    vi.advanceTimersByTime(CANDLES_TTL_MS.hour + 1);
    // Pool cache expires after 1h; simulate the pool disappearing on re-resolution.
    vi.advanceTimersByTime(60 * 60_000);
    fetchTopPool.mockResolvedValue(null);
    await expect(getDexOhlcv(req)).rejects.toBeInstanceOf(NoPoolError);
  });

  it("caches daily candles far longer than minute candles (budget: a day bar doesn't move in 30s)", async () => {
    vi.useFakeTimers();
    const dayReq = { ...req, timeframe: "day" as const };
    const minReq = { ...req, timeframe: "minute" as const, aggregate: 5 };
    await getDexOhlcv(dayReq);
    await getDexOhlcv(minReq);
    expect(fetchPoolOhlcv).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(CANDLES_TTL_MS.minute + 1);
    await getDexOhlcv(dayReq);
    await getDexOhlcv(minReq);
    expect(fetchPoolOhlcv).toHaveBeenCalledTimes(3); // only the minute key refetched

    vi.advanceTimersByTime(CANDLES_TTL_MS.day + 1);
    await getDexOhlcv(dayReq);
    expect(fetchPoolOhlcv).toHaveBeenCalledTimes(4);
  });

  it("rejects a chain with no GeckoTerminal network", async () => {
    await expect(getDexOhlcv({ ...req, chainId: 999 })).rejects.toThrow(/no DEX chart source/);
    expect(fetchTopPool).not.toHaveBeenCalled();
  });
});
