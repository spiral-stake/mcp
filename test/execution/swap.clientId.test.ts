// Locks the KyberSwap client identity: every aggregator request the swap builder makes (routes AND
// route/build, on mainnet AND Robinhood) carries x-client-id: spiralstake. KyberSwap applies a much
// stricter per-IP rate limit to unidentified requests, so a call site that drops the header silently
// degrades every live simulate/build into the public low-rps tier. The header comes from one shared
// constant (src/sources/kyberswap.ts) that the exit-liquidity sweep uses too.
import { vi, describe, it, expect, beforeEach } from "vitest";

// The receiver is the treasury SAFE: a fee-bearing swap is refused without it (see swap.receiver.test.ts).
vi.mock("../../src/config/env.ts", () => ({ env: { FEE_RECEIVER: "0x9ced716f16651b69D5167C82003690621e8F90b9" } }));
vi.mock("../../src/sources/http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sources/http.ts")>()),
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

import { getJson, postJson } from "../../src/sources/http.ts";
import { getSwapData } from "../../src/execution/swap.ts";
import { KYBER_CLIENT_ID, KYBER_HEADERS, KYBERSWAP_URL } from "../../src/sources/kyberswap.ts";

const KYBER_ROUTES = { data: { routeSummary: {}, tokenIn: "x" } };
const KYBER_BUILT = { data: { routerAddress: "0xRouter", data: "0xcalldata", amountOut: "906" } };

beforeEach(() => {
  vi.mocked(getJson).mockReset().mockResolvedValue(KYBER_ROUTES);
  vi.mocked(postJson).mockReset().mockResolvedValue(KYBER_BUILT);
});

describe("KyberSwap client id", () => {
  it("is the whitelisted id, sent as x-client-id, from a frozen shared constant", () => {
    expect(KYBER_CLIENT_ID).toBe("spiralstake");
    expect(KYBER_HEADERS).toEqual({ "x-client-id": "spiralstake" });
    expect(Object.isFrozen(KYBER_HEADERS)).toBe(true);
    expect(KYBERSWAP_URL).toBe("https://aggregator-api.kyberswap.com");
  });

  it.each([
    [1, "ethereum"],
    [4663, "robinhood"],
  ])("is sent on both the routes and route/build requests (chainId=%s)", async (chainId, slug) => {
    await getSwapData(chainId, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 0);

    const [routesUrl, routesOpts] = vi.mocked(getJson).mock.calls[0];
    expect(routesUrl).toBe(`${KYBERSWAP_URL}/${slug}/api/v1/routes?tokenIn=0xIn&tokenOut=0xOut&amountIn=1000`);
    expect(routesOpts.headers).toMatchObject({ "x-client-id": "spiralstake" });

    const [buildUrl, , buildOpts] = vi.mocked(postJson).mock.calls[0];
    expect(buildUrl).toBe(`${KYBERSWAP_URL}/${slug}/api/v1/route/build`);
    expect(buildOpts.headers).toMatchObject({ "x-client-id": "spiralstake" });
  });

  it("still sends it when the referral fee params are on the routes request", async () => {
    await getSwapData(1, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, 5);
    expect(vi.mocked(getJson).mock.calls[0][1].headers).toMatchObject({ "x-client-id": "spiralstake" });
    expect(vi.mocked(postJson).mock.calls[0][2].headers).toMatchObject({ "x-client-id": "spiralstake" });
  });
});
