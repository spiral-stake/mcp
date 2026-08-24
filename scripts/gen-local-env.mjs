// Dev helper: generate a local mcp/.env from the app's existing v2-client/.env.
// Never prints secret values — only whether each key resolved. .env is gitignored.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SRC = "../v2-client/.env";
if (!existsSync(SRC)) {
  console.error(`missing ${SRC}`);
  process.exit(1);
}
const src = readFileSync(SRC, "utf8");

const vals = new Map();
for (const line of src.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
  if (m) vals.set(m[1], m[2].replace(/^["']|["']$/g, ""));
}
const get = (k) => vals.get(k) ?? "";

const alchemy = get("VITE_ALCHEMY_KEY");
const infura = get("VITE_INFURA_ID");
const rpc = alchemy
  ? `https://eth-mainnet.g.alchemy.com/v2/${alchemy}`
  : infura
    ? `https://mainnet.infura.io/v3/${infura}`
    : "";

if (!rpc) {
  console.error("no ALCHEMY/INFURA key found — cannot build MAINNET_RPC_URL");
  process.exit(1);
}

const out =
  [
    "# Local dev env — generated from v2-client/.env by scripts/gen-local-env.mjs.",
    "# Gitignored. Read-only credentials; nothing here touches funds or signing.",
    "PORT=8787",
    "CORS_ORIGINS=http://localhost:5173,https://app.spiralstake.xyz",
    "LOG_LEVEL=info",
    "CHAIN_ID=1",
    "WARMER_ENABLED=true",
    `MAINNET_RPC_URL=${rpc}`,
    "ROBINHOOD_RPC_URL=",
    `COINGECKO_API_KEY=${get("VITE_COINGECKO_API_KEY")}`,
    `ROYCO_API_KEY=${get("VITE_ROYCO_API_KEY")}`,
    `STABLEWATCH_API_KEY=${get("VITE_STABLEWATCH_API_KEY")}`,
    `FEE_RECEIVER=${get("VITE_FEE_RECEIVER")}`,
    `OPENOCEAN_API_KEY=${get("VITE_OPENOCEAN_API_KEY")}`,
    "",
  ].join("\n");

writeFileSync(".env", out);
console.log("wrote mcp/.env");
console.log("  rpc provider:", alchemy ? "alchemy" : "infura");
for (const k of ["COINGECKO_API_KEY", "ROYCO_API_KEY", "STABLEWATCH_API_KEY"]) {
  const srcKey = `VITE_${k}`;
  console.log(`  ${k}: ${get(srcKey) ? "set" : "EMPTY"}`);
}
