// `tagize` is precision-critical: the app revives these values and runs leverage / liquidation-price
// math on them. A silent precision loss (exponential notation, Number coercion, walking a
// BigNumber's internals) would corrupt those numbers, so lock the round-trip.
import { describe, it, expect } from "vitest";
import BigNumber from "bignumber.js";
import { tagize } from "../../src/http/appMarkets.ts";

// The client-side revive counterpart the app is expected to implement.
function revive(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(revive);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$bn === "string") return new BigNumber(o.$bn);
    if (typeof o.$bigint === "string") return BigInt(o.$bigint);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = revive(val);
    return out;
  }
  return v;
}

const roundTrip = (v: unknown) => revive(JSON.parse(JSON.stringify(tagize(v))));

describe("tagize / revive round-trip", () => {
  it("preserves bigint exactly, including values beyond Number.MAX_SAFE_INTEGER", () => {
    const lltv = 945000000000000000n; // 9.45e17 — not exactly representable as a double
    expect(tagize(lltv)).toEqual({ $bigint: "945000000000000000" });
    const back = roundTrip(lltv) as bigint;
    expect(typeof back).toBe("bigint");
    expect(back).toBe(lltv);
  });

  it("preserves BigNumber without exponential notation (parseUnits rejects exponentials)", () => {
    // toString() would emit "1e-8"; toFixed() must emit "0.00000001".
    const tiny = new BigNumber("0.00000001");
    const tagged = tagize(tiny) as { $bn: string };
    expect(tagged.$bn).toBe("0.00000001");
    expect(tagged.$bn).not.toMatch(/e/i);
    expect((roundTrip(tiny) as BigNumber).isEqualTo(tiny)).toBe(true);
  });

  it("preserves high-precision BigNumber decimals", () => {
    const v = new BigNumber("1.102422000000000001");
    expect((roundTrip(v) as BigNumber).toFixed()).toBe("1.102422000000000001");
  });

  it("does not walk BigNumber internals (no s/e/c leakage)", () => {
    const json = JSON.stringify(tagize({ price: new BigNumber("1.5") }));
    expect(json).toBe('{"price":{"$bn":"1.5"}}');
    expect(json).not.toContain("_isBigNumber");
  });

  it("recurses through nested objects and arrays", () => {
    const input = {
      markets: [
        { lltv: 1n, value: new BigNumber("2.5"), nested: { deep: [new BigNumber("3")] } },
      ],
      plain: "x",
      n: 7,
      flag: true,
    };
    const out = roundTrip(input) as any;
    expect(out.markets[0].lltv).toBe(1n);
    expect((out.markets[0].value as BigNumber).toFixed()).toBe("2.5");
    expect((out.markets[0].nested.deep[0] as BigNumber).toFixed()).toBe("3");
    expect(out.plain).toBe("x");
    expect(out.n).toBe(7);
    expect(out.flag).toBe(true);
  });

  it("passes null through and drops undefined via JSON (absent = unmeasured)", () => {
    expect(tagize(null)).toBeNull();
    expect(tagize(undefined)).toBeUndefined();
    // `null` (measured, no value) must survive serialization; `undefined` keys must vanish.
    const out = JSON.parse(JSON.stringify(tagize({ a: null, b: undefined }))) as Record<string, unknown>;
    expect(out.a).toBeNull();
    expect("b" in out).toBe(false);
  });
});
