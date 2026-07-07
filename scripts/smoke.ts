// Live smoke: prime the warmer against real upstreams, then print readiness + one composed
// strategy so you can eyeball the numbers. Requires real env. Usage:
//   node --import tsx scripts/smoke.ts
import { env } from "../src/config/env.ts";
import { warmer } from "../src/warmer/index.ts";
import { buildStrategies } from "../src/core/strategy.ts";
import { rawStore } from "../src/cache/store.ts";

async function main() {
  console.error("[smoke] priming…");
  await warmer.primeOnce();
  console.error("[smoke] readiness:", JSON.stringify(warmer.readiness(), null, 2));
  console.error("[smoke] cache:", JSON.stringify(rawStore.stats(), null, 2));

  const out = buildStrategies(env.CHAIN_ID);
  console.error(`[smoke] composed ${out.count} strategies`);
  const s = out.strategies[0];
  if (s) console.log(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  warmer.stop();
  process.exit(0);
}
main().catch((e) => {
  console.error("[smoke] failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
