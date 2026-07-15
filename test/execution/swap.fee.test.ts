// Locks the fund-critical swap routing: the Pendle 10 bps currency_in fee, the KyberSwap fee params,
// per-chain routing (ethereum / robinhood), native-token mapping, and the chargeFee toggle. A
// regression here silently loses protocol fees or routes to the wrong chain, so it is CI-guarded.
import { vi, describe, it, expect, beforeEach } from "vitest";

// NOTE: vi.mock factories are hoisted above module scope — the fee literal must be inlined here.
vi.mock("../../src/config/env.ts", () => ({ env: { FEE_RECEIVER: "0x9ced716f16651b69D5167C82003690621e8F90b9" } }));
vi.mock("../../src/sources/http.ts", () => ({ getJson: vi.fn(), postJson: vi.fn() }));

const FEE = "0x9ced716f16651b69D5167C82003690621e8F90b9";

import { getJson, postJson } from "../../src/sources/http.ts";
import { getSwapData } from "../../src/execution/swap.ts";

const KYBER_ROUTES = {
  data: { routeSummary: { amountInUsd: "1000", amountOutUsd: "999" }, tokenIn: "x" },
};
const KYBER_BUILT = { data: { routerAddress: "0xRouter", data: "0xcalldata", amountOut: "906" } };
const PENDLE = { routes: [{ tx: { to: "0xPendle", data: "0xptcalldata" }, outputs: [{ amount: "501" }] }] };

beforeEach(() => {
  vi.mocked(getJson).mockReset().mockResolvedValue(KYBER_ROUTES);
  vi.mocked(postJson).mockReset();
});

describe("getSwapData — Pendle (PT collateral)", () => {
  it("routes to /v3/sdk/{chainId}/convert with the 10 bps currency_in fee", async () => {
    vi.mocked(postJson).mockResolvedValue(PENDLE);
    const res = await getSwapData(1, true, "0xRecv", "0xIn", "0xPT", 1000n, 0.005);

    const [url, body] = vi.mocked(postJson).mock.calls[0];
    expect(url).toBe("https://api-v2.pendle.finance/core/v3/sdk/1/convert");
    expect((body as any).kyberSwapParams.routes).toEqual({
      chargeFeeBy: "currency_in",
      feeAmount: "10",
      feeReceiver: FEE,
      isInBps: true,
    });
    expect(res.swapData).toEqual({ extRouter: "0xPendle", extCalldata: "0xptcalldata" });
    expect(res.amountOut).toBe(501n);
  });

  it("targets Robinhood Chain (4663) when chainId=4663", async () => {
    vi.mocked(postJson).mockResolvedValue(PENDLE);
    await getSwapData(4663, true, "0xRecv", "0xIn", "0xPT", 1000n, 0.005);
    expect(vi.mocked(postJson).mock.calls[0][0]).toBe("https://api-v2.pendle.finance/core/v3/sdk/4663/convert");
  });

  it("omits the fee when chargeFee=false", async () => {
    vi.mocked(postJson).mockResolvedValue(PENDLE);
    await getSwapData(1, true, "0xRecv", "0xIn", "0xPT", 1000n, 0.005, false);
    expect((vi.mocked(postJson).mock.calls[0][1] as any).kyberSwapParams).toBeUndefined();
  });
});

describe("getSwapData — KyberSwap (non-PT)", () => {
  it("adds the fee params on the routes request and the correct chain slug", async () => {
    vi.mocked(postJson).mockResolvedValue(KYBER_BUILT);
    const res = await getSwapData(1, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.01);

    const routesUrl = vi.mocked(getJson).mock.calls[0][0];
    expect(routesUrl).toContain("/ethereum/api/v1/routes");
    expect(routesUrl).toContain("chargeFeeBy=currency_in");
    expect(routesUrl).toContain(`feeReceiver=${FEE}`);
    expect(routesUrl).toContain("feeAmount=10");
    expect(routesUrl).toContain("isInBps=true");

    // build POST spreads the inner routeData and encodes slippage as bps-of-bps (x10000).
    const [buildUrl, buildBody] = vi.mocked(postJson).mock.calls[0];
    expect(buildUrl).toContain("/ethereum/api/v1/route/build");
    expect((buildBody as any).routeSummary).toEqual(KYBER_ROUTES.data.routeSummary);
    expect((buildBody as any).sender).toBe("0xRecv");
    expect((buildBody as any).slippageTolerance).toBe(100); // 0.01 * 10000
    expect(res.swapData).toEqual({ extRouter: "0xRouter", extCalldata: "0xcalldata" });
    expect(res.amountOut).toBe(906n);
  });

  it("uses the robinhood slug for chainId=4663", async () => {
    vi.mocked(postJson).mockResolvedValue(KYBER_BUILT);
    await getSwapData(4663, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005);
    expect(vi.mocked(getJson).mock.calls[0][0]).toContain("/robinhood/api/v1/routes");
  });

  it("maps the native zero-address to KyberSwap's 0xeee… placeholder", async () => {
    vi.mocked(postJson).mockResolvedValue(KYBER_BUILT);
    await getSwapData(1, false, "0xRecv", "0x0000000000000000000000000000000000000000", "0xOut", 1000n, 0.005);
    expect(vi.mocked(getJson).mock.calls[0][0]).toContain(`tokenIn=0x${"e".repeat(40)}`);
  });

  it("omits the fee params when chargeFee=false", async () => {
    vi.mocked(postJson).mockResolvedValue(KYBER_BUILT);
    await getSwapData(1, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005, false);
    expect(vi.mocked(getJson).mock.calls[0][0]).not.toContain("feeReceiver");
  });

  it("rejects an unsupported chain (fail-closed)", async () => {
    await expect(getSwapData(999, false, "0xRecv", "0xIn", "0xOut", 1000n, 0.005)).rejects.toThrow(/No swap aggregator/);
  });
});
