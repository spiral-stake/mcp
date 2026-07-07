// Entrypoint: start the background warmer (primes the raw cache), then serve the REST surface.
// Reads compose from warm raw only — the warmer is what keeps the numbers fresh.
import { serve } from "@hono/node-server";
import { env } from "./config/env.ts";
import { log } from "./config/logger.ts";
import { app } from "./http/app.ts";
import { warmer } from "./warmer/index.ts";

async function main() {
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  log.error("fatal boot error", { error: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
