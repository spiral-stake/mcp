// Error reporting. Optional: with no SENTRY_DSN the helpers are no-ops (logs remain the record).
// We report errors only — no performance tracing — to keep it lean. Call initSentry() as early as
// possible at boot, capture on 500s / unhandled errors and required-job failures, flush on shutdown.
import * as Sentry from "@sentry/node";
import { env } from "./env.ts";
import { log } from "./logger.ts";

let enabled = false;

export function initSentry(): void {
  if (!env.SENTRY_DSN) {
    log.warn("Sentry disabled (no SENTRY_DSN) — errors are logged only");
    return;
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    tracesSampleRate: 0, // errors only
  });
  enabled = true;
  log.info("Sentry initialized", { environment: env.SENTRY_ENVIRONMENT });
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Flush buffered events before the process exits (bounded so shutdown can't hang). */
export async function flushSentry(ms = 2000): Promise<void> {
  if (enabled) await Sentry.flush(ms).catch(() => undefined);
}
