// Shared upstream HTTP client. Native fetch only (no axios). Every call is time-bounded so a
// hung upstream can never stall the warmer; failures throw a typed error the warmer catches
// and converts into a "serve last-good" state. This layer never touches the cache — it just
// fetches + parses.
import { log } from "../config/logger.ts";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface RequestOpts {
  source: string; // upstream label for logs/errors, e.g. "morpho"
  timeoutMs?: number;
  headers?: Record<string, string>;
  // number of attempts (>=1). Retries are for transient network/5xx only.
  retries?: number;
}

async function doFetch(url: string, init: RequestInit, opts: RequestOpts): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, opts.retries ?? 1);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const ms = Date.now() - startedAt;
      if (!res.ok && res.status >= 500 && attempt < attempts) {
        log.warn("upstream 5xx, retrying", { source: opts.source, url, status: res.status, ms, attempt });
        lastErr = new UpstreamError(`HTTP ${res.status}`, opts.source, res.status);
        continue;
      }
      if (!res.ok) {
        throw new UpstreamError(`HTTP ${res.status} from ${opts.source}`, opts.source, res.status);
      }
      log.debug("upstream ok", { source: opts.source, url, status: res.status, ms });
      return res;
    } catch (e) {
      lastErr = e;
      const transient = attempt < attempts && !(e instanceof UpstreamError && (e.status ?? 0) < 500);
      log.warn("upstream fetch failed", {
        source: opts.source,
        url,
        attempt,
        willRetry: transient,
        error: e instanceof Error ? e.message : String(e),
      });
      if (!transient) break;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr instanceof UpstreamError) throw lastErr;
  throw new UpstreamError(
    `fetch failed for ${opts.source}`,
    opts.source,
    undefined,
    lastErr,
  );
}

export async function getJson<T>(url: string, opts: RequestOpts): Promise<T> {
  const res = await doFetch(url, { method: "GET", headers: opts.headers }, opts);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown, opts: RequestOpts): Promise<T> {
  const res = await doFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(body),
    },
    opts,
  );
  return (await res.json()) as T;
}
