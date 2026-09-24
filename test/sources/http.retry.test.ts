// Locks the shared HTTP client's retry contract: attempts are spaced by exponential backoff (an
// immediate retry against an overloaded upstream is a wasted attempt), 4xx is never retried,
// `retries: 1` is a single attempt, and a 5xx that outlives every attempt surfaces as an
// UpstreamError carrying the status. Measured cause: KyberSwap's Robinhood endpoint answering
// 503 "service temporarily overloaded" on most calls while the client only ever tried once.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { getJson, UpstreamError } from "../../src/sources/http.ts";

const reply = (status: number, body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Drive the pending backoff timers while the request is in flight.
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("getJson retries", () => {
  it("retries a 5xx with exponential backoff (500ms, 1s) and returns the eventual success", async () => {
    fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, { v: 1 }));
    const started = Date.now();
    const p = getJson<{ v: number }>("https://x/y", { source: "t", retries: 4 });
    // Let the first response land; the 2nd attempt must not fire before its 500ms delay.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 3rd attempt after a further 1000ms.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await settle(p)).toEqual({ v: 1 });
    expect(Date.now() - started).toBe(1500);
  });

  it("honours a custom retryDelayMs", async () => {
    fetchMock.mockResolvedValueOnce(reply(502)).mockResolvedValueOnce(reply(200));
    const p = getJson("https://x/y", { source: "t", retries: 2, retryDelayMs: 50 });
    await vi.advanceTimersByTimeAsync(49);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await settle(p);
  });

  it("throws an UpstreamError with the status when every attempt is 5xx", async () => {
    fetchMock.mockResolvedValue(reply(503));
    const p = getJson("https://x/y", { source: "kyberswap-routes", retries: 4 });
    const err = (await settle(p.catch((e) => e))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(503);
    expect(err.source).toBe("kyberswap-routes");
    expect(err.message).toBe("HTTP 503 from kyberswap-routes");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a 429 like a 5xx (rate limits clear with the backoff)", async () => {
    fetchMock.mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200, { v: 2 }));
    expect(await settle(getJson<{ v: number }>("https://x/y", { source: "t", retries: 2 }))).toEqual({ v: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a 4xx", async () => {
    fetchMock.mockResolvedValue(reply(400, { code: 4008, message: "route not found" }));
    const err = (await settle(getJson("https://x/y", { source: "t", retries: 4 }).catch((e) => e))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries: 1 is a single attempt", async () => {
    fetchMock.mockResolvedValue(reply(503));
    const err = (await settle(getJson("https://x/y", { source: "t", retries: 1 }).catch((e) => e))) as UpstreamError;
    expect(err.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
