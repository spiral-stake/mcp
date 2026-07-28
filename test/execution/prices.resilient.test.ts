// Locks the two properties that keep /v1/prices from serving an empty map:
//   1. DEDUPE  — every chain builds its price list from the same global loanTokens registry, so
//                without this each chain burns its own CoinGecko call. At 2 chains / 5 min that
//                was ~17.3k calls/month against a 10k/month Demo cap: over quota by design, the
//                key exhausted mid-month, and the job then never primed.
//   2. FALLBACK — CoinGecko being the sole source meant its exhaustion left the store EMPTY
//                (primed:false, asOf:null). Client-side that becomes valueInUsd = 0, which zeroes
//                the deposit box's USD readout and dead-ends the review overlay.
// A regression in either one takes the deposit flow down without any test going red.
import { vi, describe, it, expect, beforeEach } from "vitest";
import BigNumber from "bignumber.js";

vi.mock("../../src/sources/coingecko.ts", () => ({ fetchTokenPrices: vi.fn() }));
vi.mock("../../src/sources/defillama.ts", () => ({ fetchDefillamaPrices: vi.fn() }));

import { fetchTokenPrices } from "../../src/sources/coingecko.ts";
import { fetchDefillamaPrices } from "../../src/sources/defillama.ts";
import { fetchTokenPricesResilient, __resetPriceDedupe } from "../../src/sources/prices.ts";

const USDC = { address: "0xA0b86991", coingeckoId: "usd-coin" };
const ETH = { address: "0x00000000", coingeckoId: "ethereum" };
const TOKENS = [USDC, ETH];

beforeEach(() => {
  __resetPriceDedupe();
  vi.mocked(fetchTokenPrices).mockReset();
  vi.mocked(fetchDefillamaPrices).mockReset();
});

describe("fetchTokenPricesResilient", () => {
  it("returns CoinGecko prices when it succeeds, without touching the fallback", async () => {
    vi.mocked(fetchTokenPrices).mockResolvedValue({
      [USDC.address]: BigNumber(1),
      [ETH.address]: BigNumber(1881),
    });

    const prices = await fetchTokenPricesResilient(TOKENS);

    expect(prices[USDC.address].toNumber()).toBe(1);
    expect(prices[ETH.address].toNumber()).toBe(1881);
    expect(fetchDefillamaPrices).not.toHaveBeenCalled();
  });

  it("falls back to DeFiLlama when CoinGecko throws (the 429/quota case)", async () => {
    vi.mocked(fetchTokenPrices).mockRejectedValue(new Error("HTTP 429 from coingecko"));
    vi.mocked(fetchDefillamaPrices).mockResolvedValue({
      [USDC.address]: BigNumber(0.9998),
      [ETH.address]: BigNumber(1881.99),
    });

    const prices = await fetchTokenPricesResilient(TOKENS);

    // The whole point: a CoinGecko outage must NOT produce an empty map.
    expect(Object.keys(prices)).toHaveLength(2);
    expect(prices[USDC.address].toNumber()).toBeCloseTo(0.9998);
  });

  it("merges rather than switches — DeFiLlama fills only what CoinGecko omitted", async () => {
    vi.mocked(fetchTokenPrices).mockResolvedValue({ [USDC.address]: BigNumber(1) });
    vi.mocked(fetchDefillamaPrices).mockResolvedValue({
      [USDC.address]: BigNumber(0.5), // must NOT overwrite the CoinGecko value
      [ETH.address]: BigNumber(1881),
    });

    const prices = await fetchTokenPricesResilient(TOKENS);

    expect(prices[USDC.address].toNumber()).toBe(1);
    expect(prices[ETH.address].toNumber()).toBe(1881);
    // Only the missing token is asked for.
    expect(vi.mocked(fetchDefillamaPrices).mock.calls[0][0]).toEqual([ETH]);
  });

  it("returns an empty map (never throws) when both sources fail", async () => {
    vi.mocked(fetchTokenPrices).mockRejectedValue(new Error("HTTP 429 from coingecko"));
    vi.mocked(fetchDefillamaPrices).mockRejectedValue(new Error("network"));

    await expect(fetchTokenPricesResilient(TOKENS)).resolves.toEqual({});
  });

  it("dedupes the identical id set across chains — ONE upstream call, not one per chain", async () => {
    vi.mocked(fetchTokenPrices).mockResolvedValue({ [USDC.address]: BigNumber(1), [ETH.address]: BigNumber(1881) });

    // Both chain warmers prime simultaneously with the same (global) token list.
    const [a, b] = await Promise.all([
      fetchTokenPricesResilient(TOKENS),
      fetchTokenPricesResilient(TOKENS),
    ]);

    expect(fetchTokenPrices).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);

    // A later call inside the dedupe window still reuses it.
    await fetchTokenPricesResilient(TOKENS);
    expect(fetchTokenPrices).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure — the next cycle retries immediately", async () => {
    vi.mocked(fetchTokenPrices).mockRejectedValueOnce(new Error("HTTP 429 from coingecko"));
    vi.mocked(fetchDefillamaPrices).mockRejectedValueOnce(new Error("network"));
    await expect(fetchTokenPricesResilient(TOKENS)).resolves.toEqual({});

    vi.mocked(fetchTokenPrices).mockResolvedValue({ [USDC.address]: BigNumber(1) });
    const prices = await fetchTokenPricesResilient(TOKENS);
    expect(prices[USDC.address].toNumber()).toBe(1);
  });

  it("ignores tokens with no coingeckoId and short-circuits when none have one", async () => {
    await expect(fetchTokenPricesResilient([{ address: "0xdead" }])).resolves.toEqual({});
    expect(fetchTokenPrices).not.toHaveBeenCalled();
  });
});
