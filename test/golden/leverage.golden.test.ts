import { describe, it, expect } from "vitest";
import BigNumber from "bignumber.js";
import { calcLtv, calcLeverage, calcLeverageApy } from "../../src/core/leverage.ts";

// ── GATE: leverage.ts golden-vector test ──────────────────────────────────────
// `src/core/leverage.ts` is a *verbatim* copy of v2-client/src/utils/leverage.ts
// (a `diff` gate lives in leverage.parity.test.ts). These vectors freeze the exact
// numeric outputs the app produces, so any drift — in the copy, in bignumber.js, or
// in its default rounding (ROUND_HALF_UP, 2dp) — fails loudly.

describe("leverage.ts golden vectors", () => {
  it("calcLtv", () => {
    const bn = (s: string) => new BigNumber(s);
    expect(calcLtv(bn("100"), bn("50"), bn("1"))).toBe("50.00");
    expect(calcLtv(bn("100"), bn("81.5"), bn("1"))).toBe("81.50");
    expect(calcLtv(bn("1000"), bn("667"), bn("1.02"))).toBe("65.39");
    // Guards: 0/0 and /0 must resolve to "0.00", never NaN/Infinity.
    expect(calcLtv(bn("0"), bn("0"), bn("1"))).toBe("0.00");
    expect(calcLtv(bn("100"), bn("0"), bn("1"))).toBe("0.00");
  });

  it("calcLeverage", () => {
    expect(calcLeverage("0")).toBe("1.0");
    expect(calcLeverage("10")).toBe("1.1");
    expect(calcLeverage("50")).toBe("2.0");
    expect(calcLeverage("66.67")).toBe("3.0");
    expect(calcLeverage("81.5")).toBe("5.4");
    expect(calcLeverage("94.25")).toBe("17.4");
    expect(calcLeverage("95")).toBe("20.0");
    expect(calcLeverage("99.9")).toBe("1000.0");
  });

  it("calcLeverageApy", () => {
    expect(calcLeverageApy(true, "9.12", "4.20", "66.67")).toBe("18.96");
    expect(calcLeverageApy(true, "9.12", "4.20", "81.50")).toBe("30.77");
    // Uncorrelated flips the sign of the whole leveraged return.
    expect(calcLeverageApy(false, "9.12", "4.20", "50.00")).toBe("-14.04");
    // Negative carry (borrow > collateral APY) yields a sub-1x-collateral APY.
    expect(calcLeverageApy(true, "5.00", "6.00", "80.00")).toBe("1.00");
    expect(calcLeverageApy(true, "0.00", "0.00", "0.00")).toBe("0.00");
  });
});
