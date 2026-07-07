// Two-layer cache — RAW layer.
//
// The warmer writes per-upstream raw results here with a `staleAfterSec` budget; reads NEVER
// fetch, they only read what's warm. Graceful degradation is built into the entry model: a
// failed refresh keeps the previous good value (last-good) and records the error + attempt
// time, so a field-group can be served stale (with a visible age) rather than dropped or
// coerced to 0.
//
// In-memory only. Persistence is intentionally omitted (see CONTRACT/plan): cold start is
// handled by the warmer priming readiness before /ready flips true.

export interface CacheEntry<T = unknown> {
  /** Last successfully fetched value (last-good). */
  value: T;
  /** ms epoch of the last SUCCESSFUL fetch (the value's asOf). */
  fetchedAt: number;
  /** Freshness budget for this data class, in seconds. */
  staleAfterSec: number;
  /** ms epoch of the last fetch ATTEMPT (success or failure). */
  lastAttemptAt: number;
  /** Set when the most recent attempt failed; cleared on success. */
  lastError?: string;
}

export interface FreshView<T> {
  value: T;
  asOf: string; // ISO-8601 of fetchedAt
  asOfMs: number;
  staleAfterSec: number;
  /** true when now - fetchedAt exceeds staleAfterSec. */
  stale: boolean;
  /** seconds past the freshness budget, else 0. */
  staleForSec: number;
  degraded: boolean; // last attempt errored (serving last-good)
}

export class RawStore {
  private map = new Map<string, CacheEntry>();

  /** Record a successful fetch. */
  setOk<T>(key: string, value: T, staleAfterSec: number, now = Date.now()): void {
    this.map.set(key, {
      value,
      fetchedAt: now,
      staleAfterSec,
      lastAttemptAt: now,
      lastError: undefined,
    });
  }

  /**
   * Record a failed refresh attempt. Keeps the existing last-good value if present; if the key
   * was never populated, creates a value-less placeholder marking the failure so /ready and
   * compose can tell "never had data" from "have stale data".
   */
  setError(key: string, error: string, staleAfterSec?: number, now = Date.now()): void {
    const prev = this.map.get(key);
    if (prev) {
      prev.lastAttemptAt = now;
      prev.lastError = error;
      return;
    }
    this.map.set(key, {
      value: undefined,
      fetchedAt: 0,
      staleAfterSec: staleAfterSec ?? 0,
      lastAttemptAt: now,
      lastError: error,
    });
  }

  getEntry<T>(key: string): CacheEntry<T> | undefined {
    return this.map.get(key) as CacheEntry<T> | undefined;
  }

  /** True when the key has ever been successfully populated. */
  isPrimed(key: string): boolean {
    const e = this.map.get(key);
    return !!e && e.fetchedAt > 0;
  }

  /** Read last-good with computed freshness. Returns undefined if never populated. */
  view<T>(key: string, now = Date.now()): FreshView<T> | undefined {
    const e = this.map.get(key);
    if (!e || e.fetchedAt === 0) return undefined;
    const ageSec = (now - e.fetchedAt) / 1000;
    const staleForSec = Math.max(0, Math.floor(ageSec - e.staleAfterSec));
    return {
      value: e.value as T,
      asOf: new Date(e.fetchedAt).toISOString(),
      asOfMs: e.fetchedAt,
      staleAfterSec: e.staleAfterSec,
      stale: ageSec > e.staleAfterSec,
      staleForSec,
      degraded: !!e.lastError,
    };
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  /** Diagnostic snapshot for /health and the future debug tool. */
  stats() {
    const now = Date.now();
    return this.keys().map((key) => {
      const e = this.map.get(key)!;
      return {
        key,
        primed: e.fetchedAt > 0,
        ageSec: e.fetchedAt ? Math.floor((now - e.fetchedAt) / 1000) : null,
        staleAfterSec: e.staleAfterSec,
        stale: e.fetchedAt ? (now - e.fetchedAt) / 1000 > e.staleAfterSec : null,
        lastError: e.lastError ?? null,
        lastAttemptAt: e.lastAttemptAt ? new Date(e.lastAttemptAt).toISOString() : null,
      };
    });
  }
}

// Single process-wide raw store.
export const rawStore = new RawStore();
