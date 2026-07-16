// Per-IP fixed-window rate limiting — dependency-free, in-memory. Protects the public endpoint from a
// single client exhausting upstream quotas (KyberSwap/Pendle/RPC) via the execution builders, or
// hammering the API. Two tiers are applied in app.ts: a generous global cap plus a tighter cap on
// /mcp (where the build_* tools make the expensive live calls).
//
// CAVEAT (see #6 redundancy): counters are per-instance. Behind N instances the effective global
// limit is N x max. For a hard cluster-wide limit, back this with a shared store (Redis). For v1 the
// per-instance cap is enough to stop one client from taking a single node down.
import type { Context, Next } from "hono";

interface Window {
  count: number;
  resetAt: number;
}

// Best-effort client key: the left-most X-Forwarded-For hop (set by the LB in production), else a
// shared bucket. XFF can be spoofed, but a fronting proxy overwrites it — acceptable for v1.
function clientKey(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const buckets = new Map<string, Window>();

  return async (c: Context, next: Next) => {
    const now = Date.now();
    // A keyed partner gets its own bucket + tier; anonymous traffic falls back to per-IP.
    const partner = c.get("partner") as { id: string; rateLimitPerMin: number } | undefined;
    const key = partner ? `partner:${partner.id}` : `${opts.name}:${clientKey(c)}`;
    const max = partner?.rateLimitPerMin ?? opts.max;

    // Opportunistic prune so the map can't grow unbounded with churned IPs.
    if (buckets.size > 10_000) {
      for (const [k, w] of buckets) if (w.resetAt <= now) buckets.delete(k);
    }

    let w = buckets.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, w);
    }
    w.count++;

    const remaining = Math.max(0, max - w.count);
    c.header("RateLimit-Limit", String(max));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(Math.ceil((w.resetAt - now) / 1000)));

    if (w.count > max) {
      const retryAfter = Math.ceil((w.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: { code: "rate_limited", message: `Too many requests — retry in ${retryAfter}s` } },
        429,
      );
    }
    await next();
  };
}
