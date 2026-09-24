// The Model Context Protocol server — the native tool surface for agents (Claude/Cursor/etc.).
// Read tools are thin wrappers over the same composition the REST API uses, so an MCP client and an
// HTTP client see identical numbers. Execution tools (simulate_leverage/build_leverage_tx) are
// non-custodial: they only build UNSIGNED transactions the agent's own wallet signs.
//
// "Facts, not verdicts": tools return the raw Strategy contract; the only opinion is the namespaced
// spiralHints, which always ships its thresholds. Agents decide.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import BigNumber from "bignumber.js";
import { buildStrategies, buildStrategy } from "../core/strategy.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS } from "../cache/policy.ts";
import { simulateLeverage, buildLeverageTx } from "../execution/buildLeverage.ts";
import { buildManageTx } from "../execution/buildManage.ts";
import { simulateEquityDeposit, buildEquityDepositTx, buildEquityExitTx, getUserEquityPositions } from "../execution/equity.ts";
import { captureError } from "../config/sentry.ts";
import { PRIMARY_CHAIN_ID, SUPPORTED_CHAIN_IDS, isSupportedChain } from "../config/chains.ts";

// Tools accept an optional chainId (the MCP transport is stateless, so the chain is a tool argument).
const chainIdSchema = z
  .number()
  .int()
  .optional()
  .describe(`Chain to target. Supported: ${SUPPORTED_CHAIN_IDS.join(", ")}. Default: ${PRIMARY_CHAIN_ID}.`);

function resolveChain(id?: number): number {
  if (id == null) return PRIMARY_CHAIN_ID;
  if (!isSupportedChain(id)) throw new Error(`Unsupported chainId ${id}. Supported: ${SUPPORTED_CHAIN_IDS.join(", ")}`);
  return id;
}

// MCP tool results are content blocks; we return the data as a JSON text block (agents parse it).
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// Execution tools hit live aggregators + on-chain reads; any failure must fail-closed with a clear,
// agent-readable reason (never a half-built tx). Unexpected errors are reported to Sentry.
async function runExecution<T>(tool: string, fn: () => Promise<T>) {
  try {
    return jsonResult(await fn());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    captureError(e, { tool });
    return errorResult(`${tool} failed: ${message}`);
  }
}

const INSTRUCTIONS = `Spiral Stake exposes leveraged-yield ("looping") strategies powered by Morpho. \
Ethereum mainnet is the default; pass chainId to target another supported chain (see a tool's chainId \
field). Every field is a raw, unit-labeled fact — the only opinion is namespaced under 'spiralHints' \
and always ships its thresholds, so you can override it.

How to read the facts (mechanics, not advice):
- carry = collateralApyPct - netBorrowApyPct; leverage multiplies it. Negative carry can still leave \
a positive leverageApyPct because the 1x base yield dominates — read the leverageLadder, don't infer.
- oracle.type: 'nav' shrugs off DEX depegs; 'market' can liquidate on a depeg even if the collateral \
still redeems 1:1. Weigh against ltvPct.liquidation headroom.
- exitLiquidity.slippagePct is measured per USD size; null = no route at that size (negative = price \
improvement). maxLeverage is a liquidity bound, not a safety bound.
Only eligible strategies are returned (thin/near-maturity/no-swap-route/zero-APY markets are hidden). \
Numbers are a snapshot ('asOf'); they move. This is not financial advice.

Robinhood Chain (4663) also lists directional perps (spiralHints.profile "leveraged_perp": the APYs are \
financing carry only) and equity vaults (profile "equity_yield_vault": deposit USDG, hold a tokenized \
stock 1x, the borrowed share farms a yield loop; ids start with "equity-"). Equity vaults have their own \
tools — simulate_equity_deposit / build_equity_deposit_tx / build_equity_exit_tx — and appear under \
get_positions.equityPositions; their yield loop cannot be managed alone.

Execution is non-custodial. simulate_leverage previews a position (deterministic, no wallet). \
build_leverage_tx / build_manage_tx return an UNSIGNED transaction for the user's own wallet to sign \
— this server never signs, sends, or holds keys. It auto-selects the path (direct vs zap-swap, and \
public-allocator reallocation when liquidity is thin) in the background, just like the app. \
The canonical output is the executable payload: sign and broadcast approvals[] first, then \
tx{to,data,value} — directly, with any wallet, signer library, or Safe. meta.signingUrl is an \
ADDITIONAL convenience for human-driven sessions (a one-click link to review and sign in the app); \
surface it when a human is in the loop, but autonomous callers should execute the payload. Always \
simulate before building, and rebuild if meta.expiresAt has passed.`;

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "spiralstake", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_strategies",
    {
      title: "List Strategies",
      annotations: { title: "List Strategies", readOnlyHint: true },
      description:
        "List eligible Spiral leveraged-yield strategies with raw risk facts (collateral/borrow APY, " +
        "leverage ladder, oracle type, exit-liquidity, LTVs). Optionally filter by collateral category.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe("Filter by collateral category, e.g. 'stable', 'ETH', 'BTC', 'stable-PT'."),
        chainId: chainIdSchema,
      },
    },
    async ({ category, chainId: rawChainId }) => {
      const chainId = resolveChain(rawChainId);
      const env0 = buildStrategies(chainId);
      const strategies = category
        ? env0.strategies.filter((s) => s.collateral.category === category)
        : env0.strategies;
      return jsonResult({ asOf: env0.asOf, chainId, count: strategies.length, strategies });
    },
  );

  server.registerTool(
    "get_strategy",
    {
      title: "Get Strategy",
      annotations: { title: "Get Strategy", readOnlyHint: true },
      description: "Get one eligible strategy's full raw facts by its Morpho market id.",
      inputSchema: {
        id: z.string().describe("Morpho market id (0x followed by 64 hex chars)."),
        chainId: chainIdSchema,
      },
    },
    async ({ id, chainId: rawChainId }) => {
      const strategy = buildStrategy(resolveChain(rawChainId), id);
      if (!strategy) {
        return { content: [{ type: "text" as const, text: `No eligible strategy for id ${id}` }], isError: true };
      }
      return jsonResult(strategy);
    },
  );

  server.registerTool(
    "get_prices",
    {
      title: "Get Prices",
      annotations: { title: "Get Prices", readOnlyHint: true },
      description: "Current USD prices for loan/collateral tokens (token address -> USD).",
      inputSchema: { chainId: chainIdSchema },
    },
    async ({ chainId: rawChainId }) => {
      const view = rawStore.view<Record<string, BigNumber>>(KEYS.prices(resolveChain(rawChainId)));
      const prices: Record<string, number> = {};
      for (const [address, p] of Object.entries(view?.value ?? {})) {
        prices[address] = p instanceof BigNumber ? p.toNumber() : Number(p);
      }
      return jsonResult({ asOf: view?.asOf ?? null, prices });
    },
  );

  // ── Execution tools (non-custodial) ────────────────────────────────────────────────────────────
  // These build UNSIGNED transactions the agent's own wallet signs. The server never signs, sends,
  // holds keys, or takes custody — identical trust model to Morpho/1inch/KyberSwap MCPs.
  const leverageInput = {
    strategyId: z.string().describe("Morpho market id of the strategy (from list_strategies / get_strategy)."),
    payToken: z
      .string()
      .describe(
        "Address of the token you pay in. May be the collateral (opened directly) or any other token " +
          "(zapped: swapped to collateral first). Native ETH = the zero address 0x0000…0000.",
      ),
    amount: z.string().describe("Amount of payToken in human units (e.g. '10000' for 10,000 USDC)."),
    leverage: z.number().positive().optional().describe("Target leverage, e.g. 3. Provide this OR desiredLtv."),
    desiredLtv: z.string().optional().describe("Target LTV percent, e.g. '66.67'. Provide this OR leverage."),
    slippage: z.number().positive().optional().describe("Swap slippage as a ratio (0.005 = 0.5%). Default 0.005, capped at 0.01."),
    chainId: chainIdSchema,
  };

  server.registerTool(
    "simulate_leverage",
    {
      title: "Simulate Leverage",
      annotations: { title: "Simulate Leverage", readOnlyHint: true },
      description:
        "Preview opening a leveraged position — deterministic, read-only, no wallet needed. Returns the " +
        "resulting leverage, effective LTV, leveraged collateral, expected leveraged APY, price impact, " +
        "the auto-selected execution path, flash-loan size, and (if the flash loan exceeds direct " +
        "market liquidity) the public-allocator reallocation fee. Numbers move with market prices.",
      inputSchema: leverageInput,
    },
    async (input) => runExecution("simulate_leverage", () => simulateLeverage({ ...input, chainId: resolveChain(input.chainId) })),
  );

  server.registerTool(
    "build_leverage_tx",
    {
      title: "Build Leverage Transaction",
      annotations: { title: "Build Leverage Transaction", readOnlyHint: false, destructiveHint: false },
      description:
        "Build the UNSIGNED transaction to open a leveraged position, for the given wallet to sign. " +
        "Non-custodial: this server never signs, sends, or holds keys. The canonical output is the executable " +
        "{ approvals[], tx{to,data,value} } — sign and broadcast it directly (approvals first), plus the same " +
        "position preview as simulate_leverage. meta.signingUrl is an optional one-click link for a human to " +
        "sign in their own wallet. The embedded swap calldata is time-sensitive (see meta.expiresAt) — rebuild if stale.",
      inputSchema: {
        ...leverageInput,
        userAddress: z.string().describe("The wallet address that will sign and send. Approvals and onBehalfOf are built for it."),
      },
    },
    async (input) => runExecution("build_leverage_tx", () => buildLeverageTx({ ...input, chainId: resolveChain(input.chainId) })),
  );

  server.registerTool(
    "get_positions",
    {
      title: "Get Positions",
      annotations: { title: "Get Positions", readOnlyHint: true },
      description:
        "Read a wallet's open/closed Spiral leverage positions from chain state (read-only). For each: " +
        "collateral/loan, leveraged collateral, net equity, debt, current LTV vs liquidation LTV (with " +
        "headroom), current leverage, net USD value, and current leveraged APY. No cost-basis / realized " +
        "P&L (those need off-chain history). Newest first. `equityPositions` lists the wallet's open " +
        "equity vaults (stock leg + the yield loop(s) it funds); those loops are excluded from `positions`.",
      inputSchema: {
        userAddress: z.string().describe("Wallet address to read positions for."),
        chainId: chainIdSchema,
      },
    },
    async ({ userAddress, chainId: rawChainId }) => {
      const chainId = resolveChain(rawChainId);
      return runExecution("get_positions", async () => ({
        chainId,
        userAddress,
        ...(await getUserEquityPositions(chainId, userAddress)),
      }));
    },
  );

  server.registerTool(
    "build_manage_tx",
    {
      title: "Build Manage Transaction",
      annotations: { title: "Build Manage Transaction", readOnlyHint: false, destructiveHint: false },
      description:
        "Build the UNSIGNED transaction to adjust or close an OPEN position, for the given wallet to sign. " +
        "Non-custodial (never signs/holds keys). Canonical output is the executable { approvals[], tx{to,data,value} } " +
        "(sign/broadcast directly); meta.signingUrl is an optional link for a human to sign in their own wallet. Actions: " +
        "'close' (unwind fully), 'increase_leverage' (borrow to a higher LTV), 'add_collateral' (top up — " +
        "pay in collateral or any token), 'remove_collateral' (withdraw), 'repay' (pay down debt; set full=true " +
        "to clear it), 'borrow' (draw more loan token). Get the position `id` from get_positions. Swap calldata " +
        "(close/increase/zap paths) is time-sensitive — see meta.expiresAt.",
      inputSchema: {
        userAddress: z.string().describe("Wallet that owns the position and will sign."),
        id: z.number().int().nonnegative().describe("On-chain position index, from get_positions (its `id`)."),
        action: z
          .enum(["close", "increase_leverage", "add_collateral", "remove_collateral", "repay", "borrow"])
          .describe("What to do to the position."),
        amount: z.string().optional().describe("Human-units amount. Required for add_collateral/remove_collateral/repay/borrow."),
        payToken: z.string().optional().describe("Token to pay in (add_collateral/repay). Collateral/loan = direct; any other = zapped. ETH = zero address."),
        full: z.boolean().optional().describe("repay only: clear the entire remaining debt."),
        desiredLtv: z.string().optional().describe("increase_leverage: target LTV percent (e.g. '80'). Provide this OR leverage."),
        leverage: z.number().positive().optional().describe("increase_leverage: target leverage. Provide this OR desiredLtv."),
        slippage: z.number().positive().optional().describe("Swap slippage ratio (0.005 = 0.5%). Default 0.005, capped at 0.01."),
        chainId: chainIdSchema,
      },
    },
    async (input) => runExecution("build_manage_tx", () => buildManageTx({ ...input, chainId: resolveChain(input.chainId) })),
  );

  // ── Equity vaults (stock + yield) ─────────────────────────────────────────────────────────────
  const equityDepositInput = {
    strategyId: z.string().describe("The vault's id from list_strategies (starts with 'equity-')."),
    amount: z.string().describe("Deposit amount in human units of the vault's deposit token (USDG), e.g. '10000'."),
    stockLtvPct: z
      .string()
      .optional()
      .describe("Stock-leg LTV percent to borrow at (e.g. '50'). Default: the vault's targetLtvPct. Capped at 88% of the stock market's liquidation LTV (55 on a 62.5% market) — a higher value is refused, not clamped."),
    slippage: z.number().positive().optional().describe("Swap slippage ratio. Default 0.01 (the app's setting for vaults), capped at 0.01."),
    chainId: chainIdSchema,
  };

  server.registerTool(
    "simulate_equity_deposit",
    {
      title: "Simulate Equity Vault Deposit",
      annotations: { title: "Simulate Equity Vault Deposit", readOnlyHint: true },
      description:
        "Preview depositing USDG into a stock + yield equity vault — deterministic, read-only, no wallet. You end up 1x " +
        "long the stock (held as your own Morpho collateral), with `stockLtvPct` of its value borrowed as USDG and " +
        "flash-looped into the vault's yield strategy. Returns the stock received, the borrow, the stock liquidation " +
        "price and headroom, the yield leg's size/leverage/APY, the net APY at that LTV, fees and price impact per leg.",
      inputSchema: equityDepositInput,
    },
    async (input) => runExecution("simulate_equity_deposit", () => simulateEquityDeposit({ ...input, chainId: resolveChain(input.chainId) })),
  );

  server.registerTool(
    "build_equity_deposit_tx",
    {
      title: "Build Equity Vault Deposit",
      annotations: { title: "Build Equity Vault Deposit", readOnlyHint: false, destructiveHint: false },
      description:
        "Build the UNSIGNED call batch to deposit into a stock + yield equity vault, for the given wallet to sign. " +
        "Non-custodial. Returns `calls[]` (approve USDG → router, authorize the router on Morpho, the one-call " +
        "equityEntry, revoke) to submit as ONE atomic batch (EIP-5792 wallet_sendCalls / Safe), plus the same preview as " +
        "simulate_equity_deposit. meta.signingUrl is a one-click link for a human to sign in the app. Swap calldata is " +
        "time-sensitive (meta.expiresAt).",
      inputSchema: { ...equityDepositInput, userAddress: z.string().describe("The wallet that will sign and send; the stock leg and yield loop are opened for it.") },
    },
    async (input) => runExecution("build_equity_deposit_tx", () => buildEquityDepositTx({ ...input, chainId: resolveChain(input.chainId) })),
  );

  server.registerTool(
    "build_equity_exit_tx",
    {
      title: "Build Equity Vault Exit",
      annotations: { title: "Build Equity Vault Exit", readOnlyHint: false, destructiveHint: false },
      description:
        "Build the UNSIGNED call batch to fully unwind an OPEN equity vault (from get_positions.equityPositions): " +
        "close each of its yield loops, then one self-funded router call repays the stock debt, withdraws the stock, " +
        "swaps it to USDG and returns the proceeds. Submit as ONE atomic batch. Non-custodial; the vault's yield loop " +
        "cannot be closed alone through build_manage_tx.",
      inputSchema: {
        strategyId: z.string().describe("The vault's id ('equity-0x…')."),
        userAddress: z.string().describe("Wallet that owns the vault and will sign."),
        slippage: z.number().positive().optional().describe("Swap slippage ratio. Default 0.01, capped at 0.01."),
        chainId: chainIdSchema,
      },
    },
    async (input) => runExecution("build_equity_exit_tx", () => buildEquityExitTx({ ...input, chainId: resolveChain(input.chainId) })),
  );

  return server;
}
