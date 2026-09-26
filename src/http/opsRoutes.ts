// Keyed OPS surface — what the internal dashboard reads to see every user's portfolio exactly as the
// app renders it (execution/portfolio.ts). Gated harder than the partner API: a valid key is
// required AND it must belong to a partner on the `ops` tier, so a neobank's integration key can
// never enumerate other wallets' positions. The dashboard server holds the key; browsers never
// call this directly.
import { Hono } from "hono";
import { requirePartner, type PartnerVars } from "./partnerAuth.ts";
import { ApiError } from "./errors.ts";
import { PRIMARY_CHAIN_ID, SUPPORTED_CHAIN_IDS, isSupportedChain } from "../config/chains.ts";
import { warmer } from "../warmer/index.ts";
import { getAllPortfolios, getWalletPortfolio } from "../execution/portfolio.ts";

export const OPS_TIER = "ops";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function resolveChain(raw: string | undefined): number {
  const id = raw == null || raw === "" ? PRIMARY_CHAIN_ID : Number(raw);
  if (!Number.isInteger(id) || !isSupportedChain(id)) {
    throw new ApiError("bad_request", `Unsupported chainId '${raw}'. Supported: ${SUPPORTED_CHAIN_IDS.join(", ")}`);
  }
  return id;
}

export const opsApi = new Hono<{ Variables: PartnerVars }>();
opsApi.use("*", requirePartner);
opsApi.use("*", async (c, next) => {
  if (c.get("partner")?.tier !== OPS_TIER) throw new ApiError("unauthorized", "This key is not authorised for the ops surface.");
  await next();
});

// Every wallet's portfolio on a chain, app-shaped. Served from a 60s cache (see POLICY.portfolio);
// `stale`/`degraded` say when the numbers are older than that.
opsApi.get("/portfolios", async (c) => {
  const chainId = resolveChain(c.req.query("chainId"));
  if (!warmer.isReady(chainId)) throw new ApiError("not_ready", "Service is warming up — required data not yet primed", warmer.readiness(chainId));
  try {
    return c.json(await getAllPortfolios(chainId));
  } catch (e) {
    throw new ApiError("upstream_unavailable", `Portfolio unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// One wallet, computed live (no cache) — for drilling into a single user.
opsApi.get("/portfolio/:address", async (c) => {
  const chainId = resolveChain(c.req.query("chainId"));
  const address = c.req.param("address");
  if (!ADDRESS_RE.test(address)) throw new ApiError("bad_request", `Invalid address "${address}" (expected 0x + 40 hex chars).`);
  if (!warmer.isReady(chainId)) throw new ApiError("not_ready", "Service is warming up — required data not yet primed", warmer.readiness(chainId));
  try {
    const wallet = await getWalletPortfolio(chainId, address);
    return c.json({ asOf: new Date().toISOString(), stale: false, degraded: false, ...wallet });
  } catch (e) {
    throw new ApiError("upstream_unavailable", `Portfolio unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
});
