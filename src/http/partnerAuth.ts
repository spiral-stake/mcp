// Partner API-key auth. Two modes:
//   attachPartner — ENRICH-ONLY: attach the partner iff a valid key is present; a missing OR invalid
//                   key is ignored (never 401s). Applied to the public/agent surface (/v1/*, /mcp) so
//                   a keyed partner gets its rate tier + attribution there, WITHOUT a stray/invalid
//                   Authorization header (from a proxy, gateway, or unrelated client) breaking public
//                   traffic. Invalid keys only matter where auth is actually required.
//   requirePartner — GATE: a valid key is mandatory (401 otherwise). Applied to the keyed /v1/partner
//                   endpoints only.
import type { Context, Next } from "hono";
import { resolvePartner, type Partner } from "../partners/registry.ts";
import { ApiError } from "./errors.ts";

// Hono context var: set by the middleware, read by handlers + the rate limiter.
export type PartnerVars = { partner?: Partner };

function extractKey(c: Context): string | undefined {
  const auth = c.req.header("authorization");
  if (auth && /^bearer /i.test(auth)) return auth.slice(7).trim();
  return c.req.header("x-api-key")?.trim() || undefined;
}

export async function attachPartner(c: Context, next: Next) {
  const partner = resolvePartner(extractKey(c));
  if (partner) c.set("partner", partner); // enrich-only: an invalid/stray key is ignored, not rejected
  await next();
}

export async function requirePartner(c: Context, next: Next) {
  // Reuse the partner already resolved by attachPartner when present (avoids a second hash+lookup).
  const partner = (c.get("partner") as Partner | undefined) ?? resolvePartner(extractKey(c));
  if (!partner) {
    throw new ApiError("unauthorized", "A valid API key is required (send it as `Authorization: Bearer <key>`).");
  }
  c.set("partner", partner);
  await next();
}
