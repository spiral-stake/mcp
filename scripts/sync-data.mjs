// Config sync — copies the app's source-of-truth data files into the mcp.
//
// The app (v2-client) owns the curated market/token config; the mcp needs an identical copy to
// compose the same markets. Rather than hand-copy (which silently drifts — that's how the mcp
// ended up 5 days stale), run this so the copy is deterministic and committed. Wired into `build`
// and runnable via `npm run sync:data`.
//
// mcp-OWNED files are NOT touched: stablewatch-ids.json (from the dashboard), markets.ts (code).
// Exit-slippage inside collateralTokens.json is superseded at runtime by the live warmer; the
// synced values remain a seed/fallback.
//
// If the app sibling isn't present (mcp deployed standalone), we warn and exit 0 so the committed
// copies are used — never fail a build over a missing source.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "../../v2-client/src");
const DEST = join(here, "../src/data");

if (!existsSync(APP)) {
  console.warn(`[sync-data] app source not found at ${APP} — using committed copies. Skipping.`);
  process.exit(0);
}

// Files whose source of truth is the app, keyed by app path -> mcp path.
const FILES = [
  ["data/collateralTokens.json", "collateralTokens.json"],
  ["data/loanTokens.json", "loanTokens.json"],
  ["data/oracleTypes.json", "oracleTypes.json"],
];

let changed = 0;
function copy(fromRel, toRel) {
  const from = join(APP, fromRel);
  const to = join(DEST, toRel);
  if (!existsSync(from)) {
    console.warn(`[sync-data] missing source ${fromRel} — skipped`);
    return;
  }
  const src = readFileSync(from, "utf8");
  const prev = existsSync(to) ? readFileSync(to, "utf8") : null;
  if (src !== prev) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, src);
    changed++;
    console.log(`[sync-data] updated ${toRel}`);
  }
}

for (const [fromRel, toRel] of FILES) copy(fromRel, toRel);

// All per-chain address files (markets) — copy every *.json the app declares.
const addrDir = join(APP, "addresses");
if (existsSync(addrDir)) {
  for (const f of readdirSync(addrDir).filter((f) => f.endsWith(".json"))) {
    copy(join("addresses", f), join("addresses", f));
  }
}

console.log(`[sync-data] done — ${changed} file(s) updated.`);
