// Synthetic equity-vault strategies. Each is assembled by CLONING the underlying yield-loop Market
// (a fully-valid Market) and overriding identity + economics, so the serializer/client never receive
// a partially-shaped Market. The stock-market economics (borrow APR, liquidity, price) come from the
// warmed KEYS.equityMarkets view; the yield leg's APY comes from the yield market already composed
// in the snapshot. Appended to /v1/app/markets (and, later, /v1/strategies) — see core/strategy.ts.
import BigNumber from "bignumber.js";
import { Market, CollateralToken, CollateralTokenInfo, TokenCategory } from "../types/index.ts";
import { equityVaultsFor, type EquityVaultConfig } from "../data/equityVaults.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS } from "./../cache/policy.ts";
import { env } from "../config/env.ts";
import type { EquityMarketRaw } from "../sources/equity.ts";

// The stock tokens are Robinhood Stock Tokens (docs.robinhood.com/chain/stock-tokens): ERC-20s on
// Robinhood Chain issued by Robinhood Assets (Jersey) Limited, each giving 1:1 price exposure to one
// underlying share/ETF and priced on-chain by a Chainlink feed.
const ROBINHOOD_STOCK_TOKENS_URL = "https://docs.robinhood.com/chain/stock-tokens/";
const ROBINHOOD_TWITTER_URL = "https://x.com/RobinhoodApp";

/**
 * The stock's own token info — what the app's "i" hover / strategy title / search and the agent
 * surface's `collateral.yieldSource`, `links.yieldSource` and exit-liquidity read. Only fields that
 * are true of the STOCK vault are set; nothing is inherited from the yield leg's token.
 */
export function stockTokenInfo(v: EquityVaultConfig, yieldMarket: Market): CollateralTokenInfo {
  const stock = v.stock.symbol;
  const yieldSym = yieldMarket.collateralToken.symbol;
  const yieldProject = yieldMarket.collateralToken.info?.project;
  return {
    project: v.stock.name,
    underlyingCollateral: v.stock.underlying,
    yieldSource: `${yieldSym} loop${yieldProject ? ` (${yieldProject})` : ""}`,
    category: TokenCategory.Stocks,
    tradingViewSymbol: v.stock.tradingViewSymbol,
    description:
      `${stock} is Robinhood's tokenized ${v.stock.about} on Robinhood Chain — an ERC-20 issued by ` +
      `Robinhood Assets (Jersey) Limited that gives 1:1 price exposure to the real share, priced on-chain ` +
      `by a Chainlink feed. Deposit ${v.loanToken.symbol} and it is swapped to ${stock} and posted as ` +
      `collateral on ${v.curator}'s Morpho market; ${v.targetLtvPct}% of its value is borrowed back as ` +
      `${v.loanToken.symbol} and looped into ${yieldSym}, so you keep full ${stock} price exposure and ` +
      `earn the loop's net yield on top.`,
    website: ROBINHOOD_STOCK_TOKENS_URL,
    twitter: ROBINHOOD_TWITTER_URL,
  };
}

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
      // Built from scratch, NOT spread from the yield market's info: the clone otherwise carries the
      // yield token's description/website/twitter/yieldSource (so every stock's "i" hover read as
      // syrupUSDG), its DefiLlama/CoinGecko ids (the app would resolve the STOCK's collateral APY
      // from syrup's pool) and its exit-slippage snapshot (the agent surface would grade the stock's
      // exit liquidity on syrup's DEX depth).
      info: stockTokenInfo(v, yieldMarket),
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
      // Liquidity: the SPY stock market's real borrow-side depth — the vault's scaling ceiling. EVERY
      // liquidity field is overridden, not just the USD one: the clone carries the syrup market's
      // ~$9M, but the display ("available to borrow" reads paLiquidityAssets) and the deposit cap
      // (liquidityAssetsParsed) must reflect the STOCK market. The equity open borrows straight from
      // the stock market with no public-allocator path, so paLiquidityAssets == base liquidity and
      // there are no shared-liquidity sources.
      liquidityAssetsUsd: raw.liquidityUsd,
      liquidityAssetsParsed: BigInt(raw.liquidityAssetsParsed),
      liquidityAssets: BigNumber(raw.liquidityAssetsParsed).div(BigNumber(10).pow(yieldMarket.loanToken.decimals)),
      paLiquidityAssets: BigNumber(raw.liquidityAssetsParsed).div(BigNumber(10).pow(yieldMarket.loanToken.decimals)),
      paSharedLiquidity: [],
      supplyAssetsUsd: raw.supplyUsd,
      supplyAssets: BigNumber(raw.supplyUsd),
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
