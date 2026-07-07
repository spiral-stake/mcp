// Emit the OpenAPI spec to a file so the app can generate a typed client and partners have a
// static artifact. Run: npm run openapi  (writes openapi.json at the repo root).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openApiSpec } from "../src/http/openapi.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../openapi.json");
writeFileSync(out, JSON.stringify(openApiSpec(), null, 2) + "\n");
console.log(`wrote ${out}`);
