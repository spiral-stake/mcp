// Synthetic equity-vault strategies. Each is assembled by CLONING the underlying yield-loop Market
// (a fully-valid Market) and overriding identity + economics, so the serializer/client never receive
// a partially-shaped Market. The stock-market economics (borrow APR, liquidity, price) come from the
// warmed KEYS.equityMarkets view; the yield leg's APY comes from the yield market already composed
// in the snapshot. Appended to /v1/app/markets (and, later, /v1/strategies) — see core/strategy.ts.
import BigNumber from "bignumber.js";
import { Market, CollateralToken, TokenCategory } from "../types/index.ts";
import { equityVaultsFor } from "../data/equityVaults.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS } from "./../cache/policy.ts";
import { env } from "../config/env.ts";
import type { EquityMarketRaw } from "../sources/equity.ts";

/**
 * Build the synthetic equity Market[] for a chain. Omits any vault whose stock market isn't warmed
 * yet or whose yield market is missing from `allMarkets` — a broken/half card is never shown.
 */
export function buildEquityMarkets(chainId: number, allMarkets: Market[]): Market[] {
  if (!env.EQUITY_VAULTS_ENABLED) return []; // OFF by default — do not expose until the client funds-path ships.
  const vaults = equityVaultsFor(chainId);
  if (vaults.length === 0) return [];

  const equityData =
    rawStore.view<Record<string, EquityMarketRaw>>(KEYS.equityMarkets(chainId))?.value ?? {};

  const out: Market[] = [];
  for (const v of vaults) {
    const raw = equityData[v.stockMarketId];
    const yieldMarket = allMarkets.find(
      (m) => m.morphoMarketId.toLowerCase() === v.yieldMarketId.toLowerCase(),
    );
    if (!raw || !yieldMarket) continue;

    const yieldLegApy = BigNumber(yieldMarket.defaultLeverageApy || "0");
    const stockBorrowApy = BigNumber(raw.borrowApyPct);
    const ltvFrac = BigNumber(v.targetLtvPct).div(100);
    // Net dollar yield on the deposit: borrow `targetLtv` of the stock's value and farm it at the
    // yield-loop APY, net of the stock-leg borrow cost. Live and honest — negative when the stock
    // market is near-maxed (high borrow APR) until more USDG is supplied.
    const netApy = ltvFrac.multipliedBy(yieldLegApy.minus(stockBorrowApy)).toFixed(2);
    const stockPriceUsd = BigNumber(raw.stockPriceUsd);

    const collateralToken: CollateralToken = {
      ...yieldMarket.collateralToken,
      address: v.stock.address,
      name: v.stock.name,
      symbol: v.stock.symbol,
      decimals: v.stock.decimals,
      valueInUsd: stockPriceUsd,
      apy: "0",
      isPt: false,
      symbolExtended: undefined,
      maturity: undefined,
      maturityDate: undefined,
      maturityDaysLeft: undefined,
      underlying: undefined,
      info: {
        ...yieldMarket.collateralToken.info,
        category: TokenCategory.Stocks,
        project: v.stock.name,
      },
    };

    out.push({
      ...yieldMarket,
      morphoMarketId: v.id,
      // Surfaced under the Yield profile (dollar-yield product) — correlated=true makes the card
      // link to profile=yield and render yield-style (APY-forward) labels.
      correlated: true,
      collateralToken,
      // loanToken stays the yield market's USDG.
      borrowApy: raw.borrowApyPct,
      quarterlyBorrowApy: raw.borrowApyPct,
      collateralIncentiveApy: "0",
      collateralIncentiveBreakdown: [],
      borrowIncentiveApy: "0",
      borrowIncentiveBreakdown: [],
      borrowIncentiveHistory: [],
      collateralIncentiveHistory: [],
      collateralTokenValueInLoanToken: stockPriceUsd,
      loanTokenValueInCollateralToken: stockPriceUsd.isZero()
        ? BigNumber(0)
        : BigNumber(1).div(stockPriceUsd),
      liqLtv: v.liqLtvPct.toFixed(2),
      maxLtv: v.targetLtvPct.toFixed(2),
      safeLtv: v.targetLtvPct.toFixed(2),
      defaultLeverage: "1",
      defaultLeverageApy: netApy,
      avg30dLeverageApy: undefined,
      avg60dLeverageApy: undefined,
      avg90dLeverageApy: undefined,
      oracle: v.stock.oracle,
      oracleType: undefined,
      curators: undefined,
      visible: true,
      // The stock market's borrow-side liquidity is the vault's scaling ceiling — surface it here.
      liquidityAssetsUsd: raw.liquidityUsd,
      supplyAssetsUsd: raw.supplyUsd,
      equityVault: {
        stockMarketId: v.stockMarketId,
        targetLtvPct: v.targetLtvPct.toFixed(2),
        liqLtvPct: v.liqLtvPct.toFixed(2),
        yieldMarketId: v.yieldMarketId,
        yieldLeverage: v.yieldLeverage.toString(),
        yieldLegApyPct: yieldLegApy.toFixed(2),
        stockBorrowApyPct: raw.borrowApyPct,
        netApyPct: netApy,
        stockPriceUsd: stockPriceUsd.toFixed(4),
        morpho: v.morpho,
        stockMarketParams: {
          loanToken: v.loanToken.address,
          collateralToken: v.stock.address,
          oracle: v.stock.oracle,
          irm: v.irm,
          lltv: v.lltvRaw,
        },
      },
    });
  }
  return out;
}
