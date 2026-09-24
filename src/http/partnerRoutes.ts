// Keyed REST surface for partner (neobank) integrations. Same audited builders as the MCP agent
// tools, exposed as plain HTTP with an API-key gate + usage attribution — how a partner backend
// integrates Spiral into its own app. The fee still routes to Spiral's on-chain receiver; the
// per-partner split is reconciled off-chain from the recorded usage.
import { Hono } from "hono";
import { z } from "zod";
import { requirePartner, type PartnerVars } from "./partnerAuth.ts";
import { recordUsage } from "../partners/usage.ts";
import { simulateLeverage, buildLeverageTx } from "../execution/buildLeverage.ts";
import { buildManageTx } from "../execution/buildManage.ts";
import { simulateEquityDeposit, buildEquityDepositTx, buildEquityExitTx, getUserEquityPositions } from "../execution/equity.ts";
import { PRIMARY_CHAIN_ID, SUPPORTED_CHAIN_IDS, isSupportedChain } from "../config/chains.ts";
import { ApiError } from "./errors.ts";

function resolveChain(v?: number): number {
  const id = v ?? PRIMARY_CHAIN_ID;
  if (!isSupportedChain(id)) {
    throw new ApiError("bad_request", `Unsupported chainId ${id}. Supported: ${SUPPORTED_CHAIN_IDS.join(", ")}`);
  }
  return id;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const evmAddress = z.string().regex(ADDRESS_RE, "must be a 0x EVM address");
const chainId = z.number().int().optional();
const leverageBody = z.object({
  strategyId: z.string(),
  payToken: evmAddress, // collateral/loan/any token, or the ETH zero address
  amount: z.string(),
  leverage: z.number().positive().optional(),
  desiredLtv: z.string().optional(),
  slippage: z.number().positive().optional(),
  chainId,
});
const buildLeverageBody = leverageBody.extend({ userAddress: evmAddress });
const manageBody = z.object({
  userAddress: evmAddress,
  id: z.number().int().nonnegative(),
  action: z.enum(["close", "increase_leverage", "add_collateral", "remove_collateral", "repay", "borrow"]),
  amount: z.string().optional(),
  payToken: evmAddress.optional(),
  full: z.boolean().optional(),
  desiredLtv: z.string().optional(),
  leverage: z.number().positive().optional(),
  slippage: z.number().positive().optional(),
  chainId,
});

const equityDepositBody = z.object({
  strategyId: z.string(),
  amount: z.string(),
  stockLtvPct: z.string().optional(),
  slippage: z.number().positive().optional(),
  chainId,
});
const buildEquityDepositBody = equityDepositBody.extend({ userAddress: evmAddress });
const equityExitBody = z.object({
  strategyId: z.string(),
  userAddress: evmAddress,
  yieldPositionIds: z.array(z.number().int().nonnegative()).optional(),
  slippage: z.number().positive().optional(),
  chainId,
});

async function parseBody<S extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.json().catch(() => {
    throw new ApiError("bad_request", "Request body must be valid JSON.");
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("bad_request", `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} — ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

// Convert builder throws into clean HTTP errors: caller-fixable inputs → 400, transient/upstream
// (stale data, no swap route, RPC) → 503 (retryable). Never leaks a raw 500 for an expected failure.
async function runBuild<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unknown strategy|unknown equity vault|not an equity vault|not configured|already closed|not correlated|not currently eligible|is not available|is required|invalid|not above|above the .* cap|must be a positive|too small|no open .* equity vault|yield leg of your|yieldPositionIds|Cannot tell which|is open but no/i.test(msg)) {
      throw new ApiError("bad_request", msg);
    }
    throw new ApiError("upstream_unavailable", msg);
  }
}

export const partnerApi = new Hono<{ Variables: PartnerVars }>();
partnerApi.use("*", requirePartner);

// A wallet's open/closed positions (read-only) — the `id` here feeds /manage/build.
partnerApi.get("/positions/:address", async (c) => {
  const raw = c.req.query("chainId");
  const chain = resolveChain(raw ? Number(raw) : undefined);
  const address = c.req.param("address");
  if (!ADDRESS_RE.test(address)) throw new ApiError("bad_request", `Invalid address "${address}" (expected 0x + 40 hex chars).`);
  const { positions, equityPositions } = await runBuild(() => getUserEquityPositions(chain, address));
  return c.json({ chainId: chain, userAddress: address, positions, equityPositions });
});

// Equity vaults (stock + yield): preview, deposit batch, exit batch. Same builders as the MCP tools.
partnerApi.post("/equity/simulate", async (c) => {
  const b = await parseBody(c, equityDepositBody);
  const chain = resolveChain(b.chainId);
  const result = await runBuild(() => simulateEquityDeposit({ ...b, chainId: chain }));
  recordUsage(c.get("partner")!, { tool: "simulate_equity_deposit", chainId: chain, action: "equity_deposit", strategyId: b.strategyId });
  return c.json(result);
});

partnerApi.post("/equity/deposit/build", async (c) => {
  const b = await parseBody(c, buildEquityDepositBody);
  const chain = resolveChain(b.chainId);
  const bundle = await runBuild(() => buildEquityDepositTx({ ...b, chainId: chain }));
  recordUsage(c.get("partner")!, { tool: "build_equity_deposit_tx", chainId: chain, action: "equity_deposit", userAddress: b.userAddress, strategyId: b.strategyId, amountFlashLoan: String(bundle.meta.amountFlashLoan) });
  return c.json(bundle);
});

partnerApi.post("/equity/exit/build", async (c) => {
  const b = await parseBody(c, equityExitBody);
  const chain = resolveChain(b.chainId);
  const bundle = await runBuild(() => buildEquityExitTx({ ...b, chainId: chain }));
  recordUsage(c.get("partner")!, { tool: "build_equity_exit_tx", chainId: chain, action: "equity_exit", userAddress: b.userAddress, strategyId: b.strategyId });
  return c.json(bundle);
});

// Deterministic position preview (no wallet). Read-only.
partnerApi.post("/leverage/simulate", async (c) => {
  const b = await parseBody(c, leverageBody);
  const chain = resolveChain(b.chainId);
  const result = await runBuild(() => simulateLeverage({ ...b, chainId: chain }));
  recordUsage(c.get("partner")!, { tool: "simulate_leverage", chainId: chain, action: "open_leverage", strategyId: b.strategyId, amountFlashLoan: result.amountFlashLoan });
  return c.json(result);
});

// Unsigned open-leverage bundle for the partner's user to sign.
partnerApi.post("/leverage/build", async (c) => {
  const b = await parseBody(c, buildLeverageBody);
  const chain = resolveChain(b.chainId);
  const bundle = await runBuild(() => buildLeverageTx({ ...b, chainId: chain }));
  recordUsage(c.get("partner")!, { tool: "build_leverage_tx", chainId: chain, action: "open_leverage", userAddress: b.userAddress, strategyId: b.strategyId, amountFlashLoan: bundle.meta.amountFlashLoan });
  return c.json(bundle);
});

// Unsigned manage/close bundle for an existing position.
partnerApi.post("/manage/build", async (c) => {
  const b = await parseBody(c, manageBody);
  const chain = resolveChain(b.chainId);
  const bundle = await runBuild(() => buildManageTx({ ...b, chainId: chain }));
  recordUsage(c.get("partner")!, { tool: "build_manage_tx", chainId: chain, action: b.action, userAddress: b.userAddress, positionId: bundle.meta.positionId, amountFlashLoan: bundle.meta.amountFlashLoan });
  return c.json(bundle);
});
