// KyberSwap aggregator: the one place its base URL and client identity live. Every Kyber request in
// this service (swap.ts routes + route/build, exitLiquidity.ts sweep) MUST send KYBER_HEADERS —
// KyberSwap rate-limits requests without a client id far more aggressively than identified ones,
// and Spiral is whitelisted under "spiralstake". Import from here rather than re-typing the header
// so a new call site cannot silently land on the public low-rps tier.
export const KYBERSWAP_URL = "https://aggregator-api.kyberswap.com";
export const KYBER_CLIENT_ID = "spiralstake";
export const KYBER_HEADERS: Readonly<Record<string, string>> = Object.freeze({ "x-client-id": KYBER_CLIENT_ID });
