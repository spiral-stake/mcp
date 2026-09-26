// The ops surface is gated harder than the partner API: a missing key, an invalid key, and a valid
// key on any tier but `ops` are all rejected before the handler runs. A regression here would let a
// partner integration key enumerate every wallet's positions. Network-free.
import { vi, describe, it, expect, beforeAll } from "vitest";

const OPS_KEY = "sk_live_ops_test_key";
const PARTNER_KEY = "sk_live_partner_test_key";

// The registry reads PARTNERS_JSON at import, so it is set before any import is evaluated. Hashes are
// SHA-256 of the two keys above (precomputed: vi.hoisted runs before node:crypto could be imported).
vi.hoisted(() => {
  process.env.PARTNERS_JSON = JSON.stringify([
    { id: "ops-test", name: "Ops", keyHash: "0a24c1397d35c9a838e123d72c840f44aa3235defb25282757955b48f7488117", tier: "ops" },
    { id: "neobank", name: "Neobank", keyHash: "e2036df9488c35aab67d7930e6a2dbb9619032cfd3fc8d5130a7de11dafd6b5c", tier: "standard" },
  ]);
});
vi.mock("../../src/execution/portfolio.ts", () => ({
  getAllPortfolios: vi.fn(async (chainId: number) => ({ chainId, asOf: "now", stale: false, degraded: false, computedAt: "now", users: [], counts: {} })),
  getWalletPortfolio: vi.fn(async (chainId: number, address: string) => ({ chainId, address, header: {}, positions: [], equityPositions: [], closed: [], unresolved: [] })),
}));
vi.mock("../../src/warmer/index.ts", () => ({ warmer: { isReady: () => true, readiness: () => ({}) } }));

let app: typeof import("../../src/http/app.ts")["app"];
beforeAll(async () => {
  app = (await import("../../src/http/app.ts")).app;
});

const get = (path: string, key?: string) => app.request(path, { headers: key ? { authorization: `Bearer ${key}` } : {} });

describe("/v1/ops gate", () => {
  it("rejects a missing key", async () => {
    expect((await get("/v1/ops/portfolios")).status).toBe(401);
  });
  it("rejects an unknown key", async () => {
    expect((await get("/v1/ops/portfolios", "sk_live_nope")).status).toBe(401);
  });
  it("rejects a valid partner key that is not on the ops tier", async () => {
    expect((await get("/v1/ops/portfolios", PARTNER_KEY)).status).toBe(401);
    expect((await get("/v1/ops/portfolio/0x2222222222222222222222222222222222222222", PARTNER_KEY)).status).toBe(401);
  });
  it("serves the ops key", async () => {
    const res = await get("/v1/ops/portfolios?chainId=1", OPS_KEY);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { chainId: number }).chainId).toBe(1);
    const one = await get("/v1/ops/portfolio/0x2222222222222222222222222222222222222222", OPS_KEY);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { address: string }).address).toBe("0x2222222222222222222222222222222222222222");
  });
  it("validates inputs", async () => {
    expect((await get("/v1/ops/portfolios?chainId=999", OPS_KEY)).status).toBe(400);
    expect((await get("/v1/ops/portfolio/not-an-address", OPS_KEY)).status).toBe(400);
  });
});
