// The Model Context Protocol server — the native tool surface for agents (Claude/Cursor/etc.).
// Tools are thin wrappers over the same composition the REST API uses, so an MCP client and an
// HTTP client see identical numbers. Read-only for now; execution tools (simulate/build) come later.
//
// "Facts, not verdicts": tools return the raw Strategy contract; the only opinion is the namespaced
// spiralHints, which always ships its thresholds. Agents decide.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import BigNumber from "bignumber.js";
import { env } from "../config/env.ts";
import { buildStrategies, buildStrategy } from "../core/strategy.ts";
import { rawStore } from "../cache/store.ts";
import { KEYS } from "../cache/policy.ts";

const chainId = env.CHAIN_ID;

// MCP tool results are content blocks; we return the data as a JSON text block (agents parse it).
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

const INSTRUCTIONS = `Spiral Stake exposes leveraged-yield ("looping") strategies on Ethereum mainnet, \
powered by Morpho. Every field is a raw, unit-labeled fact — the only opinion is namespaced under \
'spiralHints' and always ships its thresholds, so you can override it.

How to read the facts (mechanics, not advice):
- carry = collateralApyPct - netBorrowApyPct; leverage multiplies it. Negative carry can still leave \
a positive leverageApyPct because the 1x base yield dominates — read the leverageLadder, don't infer.
- oracle.type: 'nav' shrugs off DEX depegs; 'market' can liquidate on a depeg even if the collateral \
still redeems 1:1. Weigh against ltvPct.liquidation headroom.
- exitLiquidity.slippagePct is measured per USD size; null = no route at that size (negative = price \
improvement). maxLeverage is a liquidity bound, not a safety bound.
Only eligible strategies are returned (thin/near-maturity/no-swap-route/zero-APY markets are hidden). \
Numbers are a snapshot ('asOf'); they move. This is not financial advice.`;

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "spiralstake", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_strategies",
    {
      description:
        "List eligible Spiral leveraged-yield strategies with raw risk facts (collateral/borrow APY, " +
        "leverage ladder, oracle type, exit-liquidity, LTVs). Optionally filter by collateral category.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe("Filter by collateral category, e.g. 'stable', 'ETH', 'BTC', 'stable-PT'."),
      },
    },
    async ({ category }) => {
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
      description: "Get one eligible strategy's full raw facts by its Morpho market id.",
      inputSchema: {
        id: z.string().describe("Morpho market id (0x followed by 64 hex chars)."),
      },
    },
    async ({ id }) => {
      const strategy = buildStrategy(chainId, id);
      if (!strategy) {
        return { content: [{ type: "text" as const, text: `No eligible strategy for id ${id}` }], isError: true };
      }
      return jsonResult(strategy);
    },
  );

  server.registerTool(
    "get_prices",
    {
      description: "Current USD prices for loan/collateral tokens (token address -> USD).",
      inputSchema: {},
    },
    async () => {
      const view = rawStore.view<Record<string, BigNumber>>(KEYS.prices(chainId));
      const prices: Record<string, number> = {};
      for (const [address, p] of Object.entries(view?.value ?? {})) {
        prices[address] = p instanceof BigNumber ? p.toNumber() : Number(p);
      }
      return jsonResult({ asOf: view?.asOf ?? null, prices });
    },
  );

  return server;
}
