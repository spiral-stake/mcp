// Equity vaults — synthetic composite strategies. A user deposits USDG, it is swapped to a tokenized
// stock and posted as collateral on an EXTERNAL Morpho market (Longbow's stock market), USDG is
// borrowed at `targetLtvPct`, and that USDG is deployed into a Spiral yield-loop strategy
// (`yieldMarketId`). This is NOT a Spiral leverage market — it is assembled in core/equity.ts from
// the warmed stock-market data + the yield-loop strategy already in the compose snapshot, and
// appended to /v1/strategies and /v1/app/markets. See KEYS.equityMarkets / POLICY.equityMarkets.
export interface EquityVaultConfig {
  chainId: number;
  /** Synthetic strategy id — namespaced so it can never collide with a real Morpho market id. */
  id: string;
  /** Morpho singleton on this chain — the client posts collateral / borrows here for the stock leg. */
  morpho: string;
  /** External Morpho market where the stock is collateral and USDG is the loan token (Longbow). */
  stockMarketId: string;
  stock: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    /** Chainlink stock/USD oracle for the stock market (used for the live stock price). */
    oracle: string;
    /** Exchange-listed symbol for the TradingView chart of the real share (the on-chain chart only goes back to the token's launch). */
    tradingViewSymbol: string;
  };
  /** The stock market's Morpho IRM address (part of its MarketParams tuple). */
  irm: string;
  /** The stock market's LLTV in raw 1e18 units (part of its MarketParams tuple). */
  lltvRaw: string;
  loanToken: { address: string; symbol: string; decimals: number };
  /** Borrow ratio on the stock leg (percent). Liquidation buffer = liqLtvPct - targetLtvPct. */
  targetLtvPct: number;
  /** The stock market's on-chain LLTV (percent) — the liquidation threshold. */
  liqLtvPct: number;
  /** Spiral yield-loop market the borrowed USDG is deployed into (must be a real Spiral market). */
  yieldMarketId: string;
  /** Leverage applied on the yield loop. */
  yieldLeverage: number;
}

export const EQUITY_VAULTS: EquityVaultConfig[] = [
  {
    chainId: 4663,
    id: "equity-0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    stockMarketId: "0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55",
    stock: {
      address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
      symbol: "SPY",
      tradingViewSymbol: "AMEX:SPY",
      name: "SPY",
      decimals: 18,
      oracle: "0xe8dAb19184f72b5a5a9d51A6C50A1b04b0669ce7",
    },
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltvRaw: "625000000000000000",
    loanToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
    targetLtvPct: 50,
    liqLtvPct: 62.5,
    yieldMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    yieldLeverage: 10.5,
  },
  {
    chainId: 4663,
    id: "equity-0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    stockMarketId: "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc",
    stock: {
      address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
      symbol: "NVDA",
      tradingViewSymbol: "NASDAQ:NVDA",
      name: "NVDA",
      decimals: 18,
      oracle: "0xC5b8A6C5fDF14f9744dB1C8595f49E42Ce23031a",
    },
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltvRaw: "625000000000000000",
    loanToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
    targetLtvPct: 50,
    liqLtvPct: 62.5,
    yieldMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    yieldLeverage: 10.5,
  },
  {
    chainId: 4663,
    id: "equity-0xb41b34c5989420ad080e79363a9cfe3e23bec7459fcd2d88029250da370288df",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    stockMarketId: "0xb41b34c5989420ad080e79363a9cfe3e23bec7459fcd2d88029250da370288df",
    stock: {
      address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
      symbol: "TSLA",
      tradingViewSymbol: "NASDAQ:TSLA",
      name: "TSLA",
      decimals: 18,
      oracle: "0xCa76875634e0b9759AA6610dC3092e92fcefE46E",
    },
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltvRaw: "625000000000000000",
    loanToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
    targetLtvPct: 50,
    liqLtvPct: 62.5,
    yieldMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    yieldLeverage: 10.5,
  },
  // NetNet Credit stock markets (same Morpho singleton, new Chainlink oracles). The NVDA one is a
  // SECOND market on the same NVDA token — the Longbow one above stays listed for its open positions.
  {
    chainId: 4663,
    id: "equity-0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    stockMarketId: "0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e",
    stock: {
      address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
      symbol: "NVDA",
      tradingViewSymbol: "NASDAQ:NVDA",
      name: "NVDA",
      decimals: 18,
      oracle: "0xED29D310cfa91778A5850538DA28ed42234Cb78c",
    },
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltvRaw: "625000000000000000",
    loanToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
    targetLtvPct: 50,
    liqLtvPct: 62.5,
    yieldMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    yieldLeverage: 10.5,
  },
  {
    chainId: 4663,
    id: "equity-0x9b4b47cdf7e295341c6c6cdfd3efb9805c4a5b3d580dba0c0c39d3a4232b297b",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    stockMarketId: "0x9b4b47cdf7e295341c6c6cdfd3efb9805c4a5b3d580dba0c0c39d3a4232b297b",
    stock: {
      address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
      symbol: "SPCX",
      tradingViewSymbol: "NASDAQ:SPCX",
      name: "SPCX",
      decimals: 18,
      oracle: "0x872F9D8955B34e841227a92dE755cd63042Ab7A5",
    },
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltvRaw: "625000000000000000",
    loanToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
    targetLtvPct: 50,
    liqLtvPct: 62.5,
    yieldMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    yieldLeverage: 10.5,
  },
  {
    chainId: 4663,
    id: "equity-0xdeb4782d012d5fd3b24962538c2f6559049d70bda4dabd2e4212dacb96c28d45",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    stockMarketId: "0xdeb4782d012d5fd3b24962538c2f6559049d70bda4dabd2e4212dacb96c28d45",
    stock: {
      address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
      symbol: "AAPL",
      tradingViewSymbol: "NASDAQ:AAPL",
      name: "AAPL",
      decimals: 18,
      oracle: "0xD625d488D552775D2867194C618B945E5dDfE097",
    },
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltvRaw: "625000000000000000",
    loanToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
    targetLtvPct: 50,
    liqLtvPct: 62.5,
    yieldMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    yieldLeverage: 10.5,
  },
  {
    chainId: 4663,
    id: "equity-0x2e1859aa8f143b7220088f80562c6dfe0bf8e52b87d9cedf8da8805f231994ce",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    stockMarketId: "0x2e1859aa8f143b7220088f80562c6dfe0bf8e52b87d9cedf8da8805f231994ce",
    stock: {
      address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
      symbol: "MSFT",
      tradingViewSymbol: "NASDAQ:MSFT",
      name: "MSFT",
      decimals: 18,
      oracle: "0xcb9a035fe0e8f321e36286405fEBC70dE42DB34e",
    },
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltvRaw: "625000000000000000",
    loanToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
    targetLtvPct: 50,
    liqLtvPct: 62.5,
    yieldMarketId: "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
    yieldLeverage: 10.5,
  },
];

export const equityVaultsFor = (chainId: number): EquityVaultConfig[] =>
  EQUITY_VAULTS.filter((v) => v.chainId === chainId);
