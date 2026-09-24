// The exit-liquidity sweep must cover every token an agent can be asked to exit: each loop
// market's collateral AND each equity vault's stock token (a vault exits by selling the stock for
// USDG on the same aggregator). Until 2026-09-24 only the loop collaterals were swept, so every
// stock vault shipped `exitLiquidity.measured: false`.
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.EQUITY_VAULTS_ENABLED = "true";
});

import { exitLiquidityTargets } from "../../src/sources/exitLiquidity.ts";
import { readMarkets } from "../../src/data/markets.ts";
import { equityVaultsFor } from "../../src/data/equityVaults.ts";

const lower = (a: string) => a.toLowerCase();

describe("exitLiquidityTargets", () => {
  it("sweeps every loop collateral plus each vault's stock token, deduped by address", () => {
    const markets = readMarkets(4663);
    const targets = exitLiquidityTargets(4663, markets).map((t) => lower(t.collateralToken.address));

    for (const m of markets) expect(targets).toContain(lower(m.collateralToken.address));
    const stocks = new Set(equityVaultsFor(4663).map((v) => lower(v.stock.address)));
    for (const s of stocks) expect(targets.filter((a) => a === s)).toHaveLength(1); // NVDA: two vaults, one sweep
    expect(targets).toHaveLength(markets.length + stocks.size);
  });

  it("carries the stock's decimals and marks it as a plain (non-PT) token", () => {
    const spy = equityVaultsFor(4663)[0];
    const t = exitLiquidityTargets(4663, []).find((x) => lower(x.collateralToken.address) === lower(spy.stock.address))!;
    expect(t.collateralToken).toEqual({ address: spy.stock.address, decimals: spy.stock.decimals, isPt: false });
  });

  it("adds nothing on a chain with no equity vaults", () => {
    const markets = readMarkets(1);
    expect(exitLiquidityTargets(1, markets)).toHaveLength(markets.length);
  });
});
