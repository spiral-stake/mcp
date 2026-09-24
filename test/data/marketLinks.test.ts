// links.market must land on a page that exists: Morpho's current market URL is
// /{chain}/variable/{id}/{loan}-{collateral} (the old /ethereum/market/{id} form 404s — on mainnet
// too, so every strategy's link was dead), Longbow's perp/stock markets live on longbow.cash, and
// NetNet Credit's on its credit page. The same registry names the partner curator.
import { describe, it, expect } from "vitest";
import { marketUrl, partnerMarketCurator, NETNET_CREDIT_URL } from "../../src/data/robinhoodMarkets.ts";
import type { Market } from "../../src/types/index.ts";

const mk = (over: Partial<Market> & { stockMarketId?: string }): Market =>
  ({
    morphoMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    collateralToken: { symbol: "syrupUSDG" },
    loanToken: { symbol: "USDG" },
    ...(over.stockMarketId ? { equityVault: { stockMarketId: over.stockMarketId } } : {}),
    ...over,
  }) as unknown as Market;

describe("marketUrl / partnerMarketCurator", () => {
  it("Spiral's mainnet markets → Morpho ethereum, no curator", () => {
    const m = mk({ morphoMarketId: "0xabc", collateralToken: { symbol: "sUSDe" } as any, loanToken: { symbol: "USDC" } as any });
    expect(marketUrl(1, m)).toBe("https://app.morpho.org/ethereum/variable/0xabc/usdc-susde#market");
    expect(partnerMarketCurator(1, m)).toBeUndefined();
  });

  it("Spiral's Robinhood loops → Morpho robinhood-chain, no curator", () => {
    const m = mk({});
    expect(marketUrl(4663, m)).toBe(
      "https://app.morpho.org/robinhood-chain/variable/0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7/usdg-syrupusdg#market",
    );
    expect(partnerMarketCurator(4663, m)).toBeUndefined();
  });

  it("Longbow's perp markets → longbow.cash by pinned slug, curator Longbow", () => {
    const cashcat = mk({ morphoMarketId: "0x039503b6308d6d818d181e626d3fbc667d6e68393c3d74332a6124cd2dd6e755", collateralToken: { symbol: "CASHCAT" } as any });
    expect(marketUrl(4663, cashcat)).toBe("https://www.longbow.cash/borrow/CASHCAT_LEGACY");
    expect(partnerMarketCurator(4663, cashcat)).toBe("Longbow");
    const wsnet = mk({ morphoMarketId: "0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589", collateralToken: { symbol: "wsNET" } as any });
    expect(marketUrl(4663, wsnet)).toBe("https://www.longbow.cash/borrow/WSNET-NN");
  });

  it("the second PONS market is Spiral's own → Morpho, no curator", () => {
    const pons2 = mk({ morphoMarketId: "0x2e1f79e5579d88b7c8528449fde8abf2499d30761e15431e4034225bb32e43e6", collateralToken: { symbol: "PONS" } as any });
    expect(marketUrl(4663, pons2)).toContain("app.morpho.org/robinhood-chain/variable/0x2e1f79e5");
    expect(partnerMarketCurator(4663, pons2)).toBeUndefined();
  });

  it("equity vaults resolve by their STOCK market: Longbow by slug, NetNet to its credit page", () => {
    const spy = mk({ morphoMarketId: "equity-0x50bc", collateralToken: { symbol: "SPY" } as any, stockMarketId: "0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55" });
    expect(marketUrl(4663, spy)).toBe("https://www.longbow.cash/borrow/SPY");
    expect(partnerMarketCurator(4663, spy)).toBe("Longbow");
    const nvdaNetNet = mk({ morphoMarketId: "equity-0x8b16", collateralToken: { symbol: "NVDA" } as any, stockMarketId: "0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e" });
    expect(marketUrl(4663, nvdaNetNet)).toBe(NETNET_CREDIT_URL);
    expect(partnerMarketCurator(4663, nvdaNetNet)).toBe("NetNet Credit");
    // A Longbow vault added later without a pinned slug still resolves by ticker.
    const later = mk({ morphoMarketId: "equity-0xnew", collateralToken: { symbol: "QQQ" } as any, stockMarketId: "0xnew" });
    expect(marketUrl(4663, later)).toBe("https://www.longbow.cash/borrow/QQQ");
  });

  it("matches market ids case-insensitively", () => {
    const upper = mk({ morphoMarketId: "0x039503B6308D6D818D181E626D3FBC667D6E68393C3D74332A6124CD2DD6E755" });
    expect(partnerMarketCurator(4663, upper)).toBe("Longbow");
  });
});
