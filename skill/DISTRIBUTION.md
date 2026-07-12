# MCP distribution checklist

The MCP is live at `https://api.spiralstake.xyz/mcp` (Streamable HTTP) and advertised in the app's
`llms.txt` / `AGENTS.md` / `robots.txt`. The steps below are the external submissions that get it
into the places agents/users discover MCP servers — these are manual (account + form per registry).

## Registries / directories (submit the URL + this repo's skill/)
- [ ] **Anthropic MCP registry** — https://github.com/modelcontextprotocol/registry (PR/submission)
- [ ] **Smithery** — https://smithery.ai (add server; supports Streamable HTTP)
- [ ] **mcp.so** — https://mcp.so/submit
- [ ] **PulseMCP** — https://www.pulsemcp.com (submit server)
- [ ] **Glama** — https://glama.ai/mcp/servers (submit)
- [ ] **Cursor MCP directory** — via Cursor's community list / docs
- [ ] **Awesome MCP servers** — PR to the relevant awesome-list(s)

For each: name `spiralstake`, transport `streamable-http`, url `https://api.spiralstake.xyz/mcp`,
tools `list_strategies`, `get_strategy`, `get_prices`, category "DeFi / crypto / finance".

## Skill
- [ ] Publish `skill/SKILL.md` (this dir) to the skill registry / `npx skills` index you target.
- [ ] Keep the skill's MCP url + tool list in sync with `src/mcp/server.ts`.

## Embed / partner (higher-leverage than registries)
- [ ] Reach out to Base agent platforms (Bankr / Velvet / agentic wallets) to add Spiral as the
      "leverage yield" capability — B2B2A distribution beats a passive registry listing.
- [ ] x402 support + listing in agent app stores (later, with execution tools).

## Verify a listing works
```
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -X POST https://api.spiralstake.xyz/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
Should return `list_strategies`, `get_strategy`, `get_prices`.
