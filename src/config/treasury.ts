// The treasury SAFE (3-of-5, deployed at the same address on Ethereum and Robinhood Chain). It is
// FlashLeverage.s_treasury on both chains and the ONLY address the swap fee may be routed to. Kept in
// its own env-free module so both the env schema and execution/swap.ts can import it without tests
// that mock config/env.ts losing it. If the treasury is ever rotated via setTreasury, change it here
// deliberately — never through the env alone.
export const TREASURY_SAFE = "0x9ced716f16651b69D5167C82003690621e8F90b9";
export const isTreasurySafe = (addr: string | undefined): boolean =>
  typeof addr === "string" && addr.toLowerCase() === TREASURY_SAFE.toLowerCase();
