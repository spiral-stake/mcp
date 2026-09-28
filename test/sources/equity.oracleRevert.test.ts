// A partner oracle may revert by design (Pare's does while its TWAP sits under the floor). That
// vault must drop out of the read on its own — not take every other stock vault's data with it.
import { vi, describe, it, expect } from "vitest";

const readContract = vi.fn();
vi.mock("../../src/sources/onchain.ts", () => ({ getClient: () => ({ readContract }) }));
vi.mock("../../src/sources/http.ts", () => ({ postJson: vi.fn() }));

import { postJson } from "../../src/sources/http.ts";
import { fetchEquityMarketsData } from "../../src/sources/equity.ts";
import { equityVaultsFor } from "../../src/data/equityVaults.ts";

const CHAIN = 4663;

describe("fetchEquityMarketsData", () => {
  it("leaves out only the vault whose oracle reverts", async () => {
    const vaults = equityVaultsFor(CHAIN);
    const pare = vaults.find((v) => v.curator === "Pare")!;
    const state = { borrowApy: 0.01, avgBorrowApy: 0.01, liquidityAssets: "1000000", liquidityAssetsUsd: 1, supplyAssetsUsd: 1 };
    vi.mocked(postJson).mockResolvedValue({ data: Object.fromEntries(vaults.map((_, i) => [`m${i}`, { state }])) });
    readContract.mockImplementation(async ({ address }: { address: string }) => {
      if (address === pare.stock.oracle) throw new Error("execution reverted");
      return 200n * 10n ** 24n;
    });

    const out = await fetchEquityMarketsData(CHAIN);

    expect(out[pare.stockMarketId]).toBeUndefined();
    const others = vaults.filter((v) => v !== pare);
    expect(Object.keys(out).sort()).toEqual([...new Set(others.map((v) => v.stockMarketId))].sort());
    for (const v of others) expect(out[v.stockMarketId].stockPriceUsd).toBe(200);
  });
});
