// Structured JSON logging with an optional correlation id. Every HTTP request gets a
// correlation id (see http/middleware.ts) that threads through the logs it triggers — this
// is the seam the future `debug` MCP tool reads. Deliberately tiny; no logging framework.
import { env } from "./env.ts";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[env.LOG_LEVEL];

export interface LogFields {
  cid?: string; // correlation id
  [key: string]: unknown;
}

function emit(level: Level, msg: string, fields?: LogFields) {
  if (ORDER[level] < threshold) return;
  const rec = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  // Serialise BigInt safely; never let a log line throw.
  const line = JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

/** A logger bound to a correlation id — use inside a request scope. */
export function childLogger(cid: string) {
  return {
    debug: (msg: string, f?: LogFields) => emit("debug", msg, { cid, ...f }),
    info: (msg: string, f?: LogFields) => emit("info", msg, { cid, ...f }),
    warn: (msg: string, f?: LogFields) => emit("warn", msg, { cid, ...f }),
    error: (msg: string, f?: LogFields) => emit("error", msg, { cid, ...f }),
  };
}
export type Logger = ReturnType<typeof childLogger>;
