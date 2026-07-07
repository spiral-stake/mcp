import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ours = resolve(here, "../../src/core/leverage.ts");
// The production app source. Path is relative to this monorepo layout; when it is not
// present (e.g. a detached checkout of just mcp/), the byte-diff gate is skipped rather
// than failing — the golden-vector test still locks the numbers.
const app = resolve(here, "../../../v2-client/src/utils/leverage.ts");

describe("leverage.ts is a verbatim copy of the app", () => {
  it("matches v2-client/src/utils/leverage.ts byte-for-byte", () => {
    if (!existsSync(app)) {
      console.warn(`[parity] app source not found at ${app} — byte-diff gate skipped`);
      return;
    }
    expect(readFileSync(ours, "utf8")).toBe(readFileSync(app, "utf8"));
  });
});
