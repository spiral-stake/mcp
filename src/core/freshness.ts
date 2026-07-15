// Fund-safety gate for the execution builders. Building a leveraged position off stale market data
// (oracle-derived collateral value, borrow liquidity) can hand a signer a reverting or mis-sized
// transaction, so the tx-builders refuse when the critical raw groups are stale past the grace
// window — the same bar the REST /v1/app/markets endpoint enforces before serving.
import { rawStore } from "../cache/store.ts";
import { KEYS, MAX_STALE_GRACE_SEC } from "../cache/policy.ts";

export function assertMarketDataFresh(chainId: number): void {
  const critical: [string, string][] = [
    ["borrow/liquidity", KEYS.morphoMarkets(chainId)],
    ["collateralValue", KEYS.onchainCollateralValue(chainId)],
  ];
  for (const [group, key] of critical) {
    const view = rawStore.view(key);
    if (!view || view.staleForSec > MAX_STALE_GRACE_SEC) {
      throw new Error(
        `Market data is too stale to build a transaction (${group}: ${view ? `${view.staleForSec}s old` : "not primed"}). Retry shortly.`,
      );
    }
  }
}
