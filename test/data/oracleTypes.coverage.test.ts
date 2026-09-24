// Every oracle an agent can be shown on Robinhood Chain must carry a curated pricing type.
// oracle.type is the fact that tells a "market" (traded-price, liquidates on a price fall) oracle
// from a "nav" (redemption-rate) one; the perps and every stock vault shipped without it until
// 2026-09-24 because oracleTypes.json only ever listed the stable loops. Mainnet is not gated here:
// two of its oracles (stakedao-FrxMsUSD, mM1-USD) are still unclassified.
import { describe, it, expect } from "vitest";
import { readMarkets, oracleTypeOf } from "../../src/data/markets.ts";
import { equityVaultsFor } from "../../src/data/equityVaults.ts";

const CHAIN = 4663;

describe("oracleTypes.json coverage — Robinhood Chain (4663)", () => {
  it("every loop / perp market resolves an oracle type", () => {
    const missing = readMarkets(CHAIN)
      .filter((m) => m.oracleType === undefined)
      .map((m) => `${m.collateralToken.symbol} ${m.oracle}`);
    expect(missing).toEqual([]);
  });

  it("every equity vault's stock oracle resolves an oracle type", () => {
    const missing = equityVaultsFor(CHAIN)
      .filter((v) => oracleTypeOf(v.stock.oracle) === undefined)
      .map((v) => `${v.stock.symbol} (${v.curator}) ${v.stock.oracle}`);
    expect(missing).toEqual([]);
  });

  it("the perps and stock oracles are traded-price feeds (market), not redemption rates", () => {
    for (const m of readMarkets(CHAIN).filter((m) => !m.correlated)) expect(m.oracleType).toBe("market");
    for (const v of equityVaultsFor(CHAIN)) expect(oracleTypeOf(v.stock.oracle)).toBe("market");
  });

  it("matches case-insensitively", () => {
    expect(oracleTypeOf("0X1BC8EDC42A2D5ABDC094E56BEC1BEBBCF516990A")).toBe("market");
    expect(oracleTypeOf(undefined)).toBeUndefined();
    expect(oracleTypeOf("0x0000000000000000000000000000000000000000")).toBeUndefined();
  });
});
