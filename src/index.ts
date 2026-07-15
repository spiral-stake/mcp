// Entrypoint: start the background warmer (primes the raw cache), then serve the REST surface.
// Reads compose from warm raw only — the warmer is what keeps the numbers fresh.
import { serve } from "@hono/node-server";
import { env } from "./config/env.ts";
import { log } from "./config/logger.ts";
import { initSentry, flushSentry, captureError } from "./config/sentry.ts";
import { app } from "./http/app.ts";
import { warmer } from "./warmer/index.ts";

async function main() {
  initSentry(); // as early as possible so boot/warmer errors are captured
  log.info("boot", { chainId: env.CHAIN_ID, port: env.PORT, warmer: env.WARMER_ENABLED });

  // Kick off warming in the background; the server comes up immediately and reports /ready=false
  // until required data is primed. Don't block boot on upstreams.
  warmer.start().catch((e) => log.error("warmer start failed", { error: e instanceof Error ? e.message : String(e) }));

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    log.info("listening", { port: info.port });
  });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    warmer.stop();
    server.close(() => void flushSentry().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Crash resilience for a multi-instance deploy. A stray promise rejection (e.g. a background
  // warmer fetch) is captured but does NOT kill the node — it keeps serving warm data. An uncaught
  // exception leaves the process in an unknown state, so we flush telemetry and exit non-zero; with
  // ≥2 instances behind the load balancer the orchestrator restarts a fresh node with no outage.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", { error: reason instanceof Error ? reason.stack : String(reason) });
    captureError(reason, { phase: "unhandledRejection" });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException", { error: err instanceof Error ? err.stack : String(err) });
    captureError(err, { phase: "uncaughtException" });
    warmer.stop();
    void flushSentry().then(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

main().catch(async (e) => {
  log.error("fatal boot error", { error: e instanceof Error ? e.stack : String(e) });
  captureError(e, { phase: "boot" });
  await flushSentry();
  process.exit(1);
});
