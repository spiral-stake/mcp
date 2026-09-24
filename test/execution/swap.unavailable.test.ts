// Locks the agent-facing failure mode of a KyberSwap outage: the routes/build calls get real
// retries, and a 5xx that outlives them is reported as a transient aggregator problem (not a bare
// "HTTP 503"), while a 4xx (e.g. "route not found") passes through untouched so a genuinely
// unroutable pair is still distinguishable from a down aggregator.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/config/env.ts", () => ({ env: { FEE_RECEIVER: undefined } }));
vi.mock("../../src/sources/http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sources/http.ts")>()),
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

import { getJson, postJson, UpstreamError } from "../../src/sources/http.ts";
import { getSwapData } from "../../src/execution/swap.ts";

const KYBER_ROUTES = { data: { routeSummary: {}, tokenIn: "x" } };
const KYBER_BUILT = { data: { routerAddress: "0xRouter", data: "0xcalldata", amountOut: "906" } };

beforeEach(() => {
  vi.mocked(getJson).mockReset();
  vi.mocked(postJson).mockReset();
});

describe("getSwapData — KyberSwap availability (Robinhood 4663)", () => {
  it("asks the http client for 4 attempts on both the routes and build calls", async () => {
    vi.mocked(getJson).mockResolvedValue(KYBER_ROUTES);
    vi.mocked(postJson).mockResolvedValue(KYBER_BUILT);
    await getSwapData(4663, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0);
    expect(vi.mocked(getJson).mock.calls[0][1]).toMatchObject({ source: "kyberswap-routes", retries: 4 });
    expect(vi.mocked(postJson).mock.calls[0][2]).toMatchObject({ source: "kyberswap-build", retries: 4 });
  });

  it("reports a persisting 503 on routes as a transient aggregator outage", async () => {
    vi.mocked(getJson).mockRejectedValue(new UpstreamError("HTTP 503 from kyberswap-routes", "kyberswap-routes", 503));
    await expect(getSwapData(4663, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0)).rejects.toThrow(
      "KyberSwap (robinhood) is temporarily unavailable: HTTP 503 from kyberswap-routes on all 4 attempts. This is transient — retry in a few seconds.",
    );
    expect(postJson).not.toHaveBeenCalled();
  });

  it("reports a persisting 5xx on build the same way", async () => {
    vi.mocked(getJson).mockResolvedValue(KYBER_ROUTES);
    vi.mocked(postJson).mockRejectedValue(new UpstreamError("HTTP 502 from kyberswap-build", "kyberswap-build", 502));
    await expect(getSwapData(4663, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0)).rejects.toThrow(
      /KyberSwap \(robinhood\) is temporarily unavailable: HTTP 502 from kyberswap-build/,
    );
  });

  it("reports a persisting 429 as rate-limited and transient", async () => {
    vi.mocked(getJson).mockRejectedValue(new UpstreamError("HTTP 429 from kyberswap-routes", "kyberswap-routes", 429));
    await expect(getSwapData(4663, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0)).rejects.toThrow(
      "KyberSwap (robinhood) is rate-limited: HTTP 429 from kyberswap-routes on all 4 attempts. This is transient — retry in a few seconds.",
    );
  });

  it("passes a 4xx (route not found) through unchanged", async () => {
    const notFound = new UpstreamError("HTTP 400 from kyberswap-routes", "kyberswap-routes", 400);
    vi.mocked(getJson).mockRejectedValue(notFound);
    await expect(getSwapData(4663, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0)).rejects.toBe(notFound);
  });

  it("passes a malformed build reply through unchanged", async () => {
    vi.mocked(getJson).mockResolvedValue(KYBER_ROUTES);
    vi.mocked(postJson).mockResolvedValue({ data: {} });
    await expect(getSwapData(4663, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0)).rejects.toThrow(
      "KyberSwap route/build returned no calldata",
    );
  });
});
