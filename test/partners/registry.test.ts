// Guards the partner API-key gate: only the exact issued key (matched by SHA-256 hash) resolves to a
// partner; anything else is rejected. A regression here is an auth-bypass on the keyed partner
// surface, so it's CI-guarded. Network-free.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

const KEY = "sk_live_abc123def456";
const keyHash = createHash("sha256").update(KEY).digest("hex");

let resolvePartner: (k?: string) => { id: string; rateLimitPerMin: number } | null;
let partnersConfigured: () => boolean;

beforeAll(async () => {
  // registry loads PARTNERS_JSON at import — set it first, then import.
  process.env.PARTNERS_JSON = JSON.stringify([{ id: "tori", name: "Tori Finance", keyHash, rateLimitPerMin: 500, tier: "launch" }]);
  const mod = await import("../../src/partners/registry.ts");
  resolvePartner = mod.resolvePartner as typeof resolvePartner;
  partnersConfigured = mod.partnersConfigured;
});

describe("partner registry", () => {
  it("resolves the exact issued key to its partner", () => {
    const p = resolvePartner(KEY);
    expect(p?.id).toBe("tori");
    expect(p?.rateLimitPerMin).toBe(500);
  });

  it("rejects a wrong key", () => {
    expect(resolvePartner("sk_live_wrong")).toBeNull();
  });

  it("rejects a key that is the hash itself (not the raw key)", () => {
    expect(resolvePartner(keyHash)).toBeNull();
  });

  it("rejects undefined and empty", () => {
    expect(resolvePartner(undefined)).toBeNull();
    expect(resolvePartner("")).toBeNull();
  });

  it("tolerates surrounding whitespace on a valid key", () => {
    expect(resolvePartner(`  ${KEY}  `)?.id).toBe("tori");
  });

  it("reports the surface as configured", () => {
    expect(partnersConfigured()).toBe(true);
  });
});
