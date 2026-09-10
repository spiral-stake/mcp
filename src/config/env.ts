// Centralised, validated configuration. All secrets/URLs come from the process
// environment only — never checked in, never passed on the wire. A `.env` (if present)
// is loaded once at startup via Node's built-in support.
import { z } from "zod";

// Node 20.6+ supports `--env-file`; we also load a local .env manually so `tsx`/tests
// pick it up without a flag. Kept dependency-free (no dotenv).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!m) continue;
        const [, key, valRaw] = m;
        if (process.env[key] !== undefined) continue; // real env wins
        const val = valRaw.replace(/^["']|["']$/g, "");
        process.env[key] = val;
      }
    } catch {
      /* file absent — fine */
    }
  }
}
loadDotEnv();

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  CHAIN_ID: z.coerce.number().int().positive().default(1),
  // Web app base URL — used to build the human "sign in your wallet" deep-link on execution bundles.
  APP_URL: z.string().url().default("https://app.spiralstake.xyz"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  WARMER_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),

  // Eligibility thresholds — MUST mirror the app's filterMarkets (v2-client Strategies.tsx):
  // VITE_MIN_BORROWABLE_USD and VITE_PT_MINIMUM_MATURITY_DAYS. Used to hide unusable strategies
  // from the agent endpoint (/v1/strategies).
  MIN_BORROWABLE_USD: z.coerce.number().nonnegative().default(10000),
  PT_MINIMUM_MATURITY_DAYS: z.coerce.number().nonnegative().default(10),

  MAINNET_RPC_URL: z.string().url().optional(),
  ROBINHOOD_RPC_URL: z.string().url().optional().or(z.literal("")),
  COINGECKO_API_KEY: z.string().optional(),
  // CoinGecko PAID key (Basic+). Optional: absent → DEX OHLCV (/v1/prices/ohlcv) reads the public
  // GeckoTerminal API (~30 req/min, no key); present → the same paths on pro-api.coingecko.com at
  // 300–500 req/min. Nothing else changes, so this is the rate-limit upgrade path for the perp charts.
  COINGECKO_PRO_API_KEY: z.string().optional(),
  ROYCO_API_KEY: z.string().optional(),
  // StableWatch is fetched directly (the mcp owns /apy now). Optional: absent → the stable-APY
  // group degrades to last-good/empty rather than blocking boot.
  STABLEWATCH_API_KEY: z.string().optional(),

  // Error reporting (optional — absent = disabled, logs only).
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("production"),

  // Execution (C): fee receiver for the swap fee — 5 bps correlated / 25 bps non-correlated, see
  // execution/swap.ts (mirrors the app's VITE_FEE_RECEIVER). Absent → no fee charged, as the app.
  FEE_RECEIVER: z.string().optional(),

  // OpenOcean aggregator (mainnet only) — raced against KyberSwap for best execution. The Pro
  // endpoint needs an `apikey` header. Presence of this key is the on/off switch: absent → KyberSwap
  // only, behaviour unchanged. Configure it ONLY after its router (0x6352…e64) is whitelisted on-chain
  // via FlashLeverage.setSwapRouter — until then a winning OpenOcean quote would revert.
  OPENOCEAN_API_KEY: z.string().optional(),

  // Equity vaults (synthetic stock strategies). OFF by default: the strategy must NOT appear on any
  // surface until the client's equity render + composite open/exit are built and simulated, or a
  // user could deposit through the wrong (standard-leverage) flow. Flip to true only when the full
  // client funds-path ships. See data/equityVaults.ts, core/equity.ts.
  EQUITY_VAULTS_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),

  // Kill switch for the OpenOcean race, independent of the key. Default on; set OPENOCEAN_ENABLED=false
  // to fall back to KyberSwap-only WITHOUT removing OPENOCEAN_API_KEY (so it can be flipped back on
  // instantly). Absent → enabled, behaviour unchanged. Note the key is still the hard gate: no key →
  // no race regardless of this flag.
  OPENOCEAN_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() !== "false"),

  // Partner integration API (neobanks). A JSON array of { id, name, keyHash, rateLimitPerMin?, tier? }
  // where keyHash is the SHA-256 hex of the issued key (raw keys never touch config). Absent/empty →
  // the partner surface is dormant and the public/agent behaviour is unchanged.
  PARTNERS_JSON: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast and loud — misconfiguration must never boot into a silently-degraded state.
  console.error("[config] invalid environment:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
export type Env = typeof env;
