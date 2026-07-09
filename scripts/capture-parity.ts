// Live parity capture (requires real env: MAINNET_RPC_URL, COINGECKO_API_KEY, ROYCO_API_KEY,
// STABLEWATCH_API_KEY). Primes the warmer against real upstreams, then writes the composed
// /strategies output (+ app-surface reads) to test/fixtures/ as the golden snapshot.
//
// The parity gate is completed by diffing this golden against the app's current client-side
// composition for the SAME fixed market set (the app logs its composed markets; see README
// "Parity"). Commit the fixtures + the (empty) diff in the PR.
//
// Usage:
//   node --import tsx scripts/capture-parity.ts [--markets id1,id2,...]
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../src/config/env.ts";
import { warmer } from "../src/warmer/index.ts";
import { buildStrategies } from "../src/core/strategy.ts";
import { composeSnapshot } from "../src/core/compose.ts";
import { rawStore } from "../src/cache/store.ts";
import { KEYS } from "../src/cache/policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../test/fixtures");

function jsonReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--markets="));
  const only = arg ? arg.slice("--markets=".length).split(",").map((s) => s.trim().toLowerCase()) : null;

  console.error("[capture] priming warmer against live upstreams…");
  await warmer.primeOnce();

  const readiness = warmer.readiness();
  console.error("[capture] readiness:", JSON.stringify(readiness));

  const env0 = buildStrategies(env.CHAIN_ID);
  const strategies = only
    ? env0.strategies.filter((s) => only.includes(s.id.toLowerCase()))
    : env0.strategies;

  // App-surface reads bundled alongside for the same input.
  const snapshot = composeSnapshot(env.CHAIN_ID);
  const apyHistories = Object.fromEntries(
    snapshot.markets.map((m) => [m.market.morphoMarketId, m.apyHistory]),
  );
  const borrowHistories = rawStore.view(KEYS.morphoBorrowHistory(env.CHAIN_ID))?.value ?? {};

  mkdirSync(outDir, { recursive: true });
  const golden = { asOf: env0.asOf, chainId: env0.chainId, count: strategies.length, strategies };
  writeFileSync(resolve(outDir, "golden-strategies.json"), JSON.stringify(golden, jsonReplacer, 2) + "\n");
  writeFileSync(resolve(outDir, "golden-apy-histories.json"), JSON.stringify(apyHistories, jsonReplacer, 2) + "\n");
  writeFileSync(resolve(outDir, "golden-borrow-histories.json"), JSON.stringify(borrowHistories, jsonReplacer, 2) + "\n");

  console.error(`[capture] wrote ${strategies.length} strategies to ${outDir}`);
  warmer.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error("[capture] failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
