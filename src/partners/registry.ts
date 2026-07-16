// Partner registry for the neobank integration API. Loaded once from env.PARTNERS_JSON — a JSON
// array of partners where only the SHA-256 hash of each API key is stored (raw keys are issued
// out-of-band and never live in config or logs). Empty/unset → the partner surface is dormant and
// public/agent behaviour is unchanged.
//
// Keys are issued as `sk_live_<random>`; a partner presents it as `Authorization: Bearer <key>`.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.ts";
import { log } from "../config/logger.ts";

const PartnerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/i, "keyHash must be SHA-256 hex"),
  // Conservative default — each build call spends live aggregator (KyberSwap/Pendle) + RPC quota,
  // so set this per-partner to their real need rather than relying on the default.
  rateLimitPerMin: z.number().int().positive().default(120),
  tier: z.string().default("standard"),
});
export type Partner = z.infer<typeof PartnerSchema>;

const byHash = new Map<string, Partner>();

(function load() {
  if (!env.PARTNERS_JSON) return;
  let raw: unknown;
  try {
    raw = JSON.parse(env.PARTNERS_JSON);
  } catch {
    log.error("PARTNERS_JSON is not valid JSON — no partners loaded");
    return;
  }
  const parsed = z.array(PartnerSchema).safeParse(raw);
  if (!parsed.success) {
    log.error("PARTNERS_JSON failed validation — no partners loaded", { error: parsed.error.message });
    return;
  }
  for (const p of parsed.data) byHash.set(p.keyHash.toLowerCase(), p);
  log.info("partners loaded", { count: byHash.size, ids: parsed.data.map((p) => p.id) });
})();

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

// Resolve a presented API key to a partner, or null. Constant-time confirm after the hash lookup so
// the comparison can't be timing-probed.
export function resolvePartner(presentedKey: string | undefined): Partner | null {
  if (!presentedKey) return null;
  const hash = sha256Hex(presentedKey.trim());
  const partner = byHash.get(hash);
  if (!partner) return null;
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(partner.keyHash.toLowerCase(), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return partner;
}

export const partnersConfigured = (): boolean => byHash.size > 0;
