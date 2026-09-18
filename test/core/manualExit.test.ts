// Manual-exit markets: listed in the app without a DEX exit route, kept off the agent surface, and
// reverting to a normal market by themselves once a real route is measured.
import { describe, it, expect } from "vitest";
import { isExitNoRoute, isManualExitOnly } from "../../src/core/exitLiquidity.ts";
import { isAgentEligible } from "../../src/core/strategy.ts";
import type { Market } from "../../src/types/index.ts";

const market = (visible: boolean, info: Record<string, unknown>) =>
  ({ visible, collateralToken: { info } }) as unknown as Market;

describe("isManualExitOnly", () => {
  it("is true only when the flag is set AND the route is missing", () => {
    expect(isManualExitOnly({ manualExitOnly: true, exitSlippage100k: null })).toBe(true);
    expect(isManualExitOnly({ manualExitOnly: true, exitSlippage100k: 5 })).toBe(true); // > listing gate
  });

  it("turns off by itself once a usable route is measured", () => {
    expect(isManualExitOnly({ manualExitOnly: true, exitSlippage100k: 0.4 })).toBe(false);
  });

  it("is false without the curated flag, even with no route (market stays hidden)", () => {
    const info = { exitSlippage100k: null };
    expect(isExitNoRoute(info)).toBe(true);
    expect(isManualExitOnly(info)).toBe(false);
  });

  it("is false when unmeasured or when info is missing", () => {
    expect(isManualExitOnly({ manualExitOnly: true })).toBe(false);
    expect(isManualExitOnly(undefined)).toBe(false);
  });
});

describe("isAgentEligible", () => {
  it("keeps a manual-exit market off the agent surface even though the app lists it", () => {
    expect(isAgentEligible(market(true, { manualExitOnly: true, exitSlippage100k: null }))).toBe(false);
  });

  it("passes a normal visible market and rejects a hidden one", () => {
    expect(isAgentEligible(market(true, { exitSlippage100k: 0.1 }))).toBe(true);
    expect(isAgentEligible(market(false, { exitSlippage100k: 0.1 }))).toBe(false);
  });

  it("re-admits the market once its route is live", () => {
    expect(isAgentEligible(market(true, { manualExitOnly: true, exitSlippage100k: 0.4 }))).toBe(true);
  });
});
