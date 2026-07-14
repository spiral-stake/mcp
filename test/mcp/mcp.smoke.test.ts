// MCP protocol smoke test — drives the real hono app's /mcp endpoint through a full
// initialize -> tools/list -> tools/call cycle over Streamable HTTP (JSON response mode).
import { describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";
import { app } from "../../src/http/app.ts";
import { rawStore } from "../../src/cache/store.ts";
import { KEYS } from "../../src/cache/policy.ts";
import { readMarkets } from "../../src/data/markets.ts";
import type { MorphoMarketData } from "../../src/sources/morpho.ts";

const CHAIN = 1;
const m0 = readMarkets(CHAIN)[0]; // sUSDS/AUSD — correlated, stable, eligible

function seed() {
  const morpho: Record<string, MorphoMarketData> = {
    [m0.morphoMarketId]: {
      borrowApy: "5.00",
      quarterlyBorrowApy: "5.10",
      supplyAssets: new BigNumber("1000000"),
      supplyAssetsUsd: 1_000_000,
      liquidityAssetsParsed: 0n,
      liquidityAssets: new BigNumber("400000"),
      liquidityAssetsUsd: 400_000,
      paLiquidityAssets: new BigNumber("500000"),
      paSharedLiquidity: [],
    },
  };
  rawStore.setOk(KEYS.morphoMarkets(CHAIN), morpho, 300);
  rawStore.setOk(KEYS.onchainCollateralValue(CHAIN), { [m0.morphoMarketId]: new BigNumber("1.02") }, 900);
  rawStore.setOk(KEYS.prices(CHAIN), { [m0.loanToken.address]: new BigNumber("1") }, 300);
  rawStore.setOk(
    KEYS.stablewatchApy(),
    { stableApy: [{ id: m0.collateralToken.info!.stablewatchId, metrics: { apy: { avg7d: 10 } }, history: [] }] },
    43200,
  );
  rawStore.setOk(KEYS.merkl(CHAIN), { spot: {}, histories: {} }, 3600);
}

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body: unknown) {
  const res = await app.request("/mcp", { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const text = await res.text();
  // JSON-response mode returns a single JSON object (SSE-framed lines stripped defensively).
  const json = JSON.parse(text.replace(/^event:.*$/gm, "").replace(/^data: /gm, "").trim());
  return { status: res.status, json };
}

describe("MCP /mcp endpoint", () => {
  beforeEach(seed);

  it("initialize returns serverInfo + tools capability", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(json.result.serverInfo.name).toBe("spiralstake");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("tools/list exposes the read tools", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = (json.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["build_leverage_tx", "get_positions", "get_prices", "get_strategy", "list_strategies", "simulate_leverage"]);
  });

  it("tools/call get_strategy returns the strategy's raw facts", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_strategy", arguments: { id: m0.morphoMarketId } },
    });
    const payload = JSON.parse(json.result.content[0].text);
    expect(payload.id).toBe(m0.morphoMarketId);
    expect(payload.oracle.type).toBeDefined();
    expect(payload.leverageLadder[0].leverage).toBe("1.0");
  });

  it("tools/call get_strategy on an unknown id is a tool error, not a crash", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_strategy", arguments: { id: "0xdeadbeef" } },
    });
    expect(json.result.isError).toBe(true);
  });
});
