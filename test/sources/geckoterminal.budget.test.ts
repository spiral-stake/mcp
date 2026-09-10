// sources/geckoterminal — the upstream budget. The public API 429s past ~30 req/min; these prove
// that calls beyond the budget wait for the window instead of firing, that a flood fails fast, and
// that a stray 429 gets exactly one retry.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock("../../src/sources/http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sources/http.ts")>();
  return { ...actual, getJson };
});

import { fetchPoolOhlcv, sanitizeCandles, _resetGeckoBudget } from "../../src/sources/geckoterminal.ts";
import { UpstreamError } from "../../src/sources/http.ts";

const POOL = { address: "0xd42a491087a15e5afd51feb3606066cc152d2b09", name: "x", dex: "x", reserveUsd: 1, tokenSide: "base" as const };
const OK = { data: { attributes: { ohlcv_list: [[1, 1, 1, 1, 1, 1]] } } };
const call = () => fetchPoolOhlcv("robinhood", POOL, "hour", 1, 1);

describe("geckoterminal budget", () => {
  beforeEach(() => {
    _resetGeckoBudget();
    getJson.mockReset().mockResolvedValue(OK);
    vi.useFakeTimers();
  });

  it("lets 25 calls through immediately, then holds the 26th until the window slides", async () => {
    for (let i = 0; i < 25; i++) await call();
    expect(getJson).toHaveBeenCalledTimes(25);

    // 55s later the oldest slot frees in ~5s — inside the wait bound, so the call waits rather than fails.
    await vi.advanceTimersByTimeAsync(55_000);
    const held = call();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getJson).toHaveBeenCalledTimes(25); // still waiting

    await vi.advanceTimersByTimeAsync(5_000);
    await held;
    expect(getJson).toHaveBeenCalledTimes(26);
  });

  it("fails fast (429) when the wait would exceed the bound, rather than queueing a flood", async () => {
    for (let i = 0; i < 25; i++) await call();
    // The window won't free a slot for ~60s, far past the 8s wait bound.
    await expect(call()).rejects.toMatchObject({ status: 429 });
    expect(getJson).toHaveBeenCalledTimes(25);
  });

  it("retries a 429 once after a pause, then gives up", async () => {
    getJson.mockRejectedValueOnce(new UpstreamError("HTTP 429", "geckoterminal", 429));
    const p = call();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toHaveLength(1);
    expect(getJson).toHaveBeenCalledTimes(2);

    getJson.mockRejectedValue(new UpstreamError("HTTP 429", "geckoterminal", 429));
    const p2 = call();
    // Attach the handler before advancing so a rejection between ticks is never unhandled.
    const result = expect(p2).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(getJson).toHaveBeenCalledTimes(4);
  });
});

describe("sanitizeCandles (artifact guard)", () => {
  const c = (t: number, close: number, v: number) => ({ t, o: close, h: close, l: close, c: close, v });
  const RESERVE = 8_500_000; // the SPY/USDG pool

  it("flattens a >10% move on dust volume and the zero-volume candle that carries it", () => {
    // The real SPY case: steady ~$761, then $900 on $180 of volume, then $900 on 0, then back.
    const series = [c(1, 761, 3000), c(2, 762, 2500), c(3, 761, 4000), c(4, 900, 180), c(5, 900, 0), c(6, 767, 2000)];
    const out = sanitizeCandles(series, RESERVE);
    expect(out.map((x) => x.c)).toEqual([761, 762, 761, 761, 761, 767]);
    expect(out[3]!.v).toBe(180); // volume is kept, only price is flattened
  });

  it("keeps a real large move that comes with volume proportional to the pool", () => {
    const series = [c(1, 0.1, 50_000), c(2, 0.1, 60_000), c(3, 0.14, 400_000), c(4, 0.13, 300_000)];
    expect(sanitizeCandles(series, 5_000_000).map((x) => x.c)).toEqual([0.1, 0.1, 0.14, 0.13]);
  });

  it("keeps a small move on dust volume (quiet market, not an artifact)", () => {
    const series = [c(1, 100, 5000), c(2, 101, 10), c(3, 100.5, 0), c(4, 100, 4000)];
    expect(sanitizeCandles(series, RESERVE).map((x) => x.c)).toEqual([100, 101, 100.5, 100]);
  });

  it("does nothing when the pool depth is unknown", () => {
    const series = [c(1, 761, 3000), c(2, 900, 0)];
    expect(sanitizeCandles(series, 0).map((x) => x.c)).toEqual([761, 900]);
  });
});
