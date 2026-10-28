/**
 * Runtime configuration. Everything external has a mock mode so the demo
 * replays deterministically and the app runs with zero credentials.
 */

// Scripts (tsx) do not load .env on their own; Next does. Load it here so both agree.
// Variables already set in the environment win. Skipped silently where unsupported (edge runtime).
// Never under the test runner: a developer's real .env (logins, live keys, a bank account) must not
// change what the tests prove, and must not let a test reach a live rail.
try {
  const pl = process as unknown as { loadEnvFile?: (path?: string) => void };
  if (typeof pl.loadEnvFile === "function" && !process.env.VITEST) pl.loadEnvFile(".env");
} catch {
  /* no .env file, or not supported here */
}

export type RailMode = "mock" | "live";
export type AiMode = "mock" | "live";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** PYUSD issuer on Stellar testnet. Must never be used on the public network. */
export const TESTNET_PYUSD_ISSUER = "GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G";

export const config = {
  appName: "Checkrail Pay",
  domain: "checkrailpay.com",
  tagline: "Verified supplier payments, routed and reconciled automatically.",
  dbPath: env("DATABASE_PATH", "./data/checkrail-pay.sqlite"),

  rails: {
    mode: (env("RAIL_MODE", "mock") as RailMode),
    paypal: {
      clientId: env("PAYPAL_CLIENT_ID"),
      clientSecret: env("PAYPAL_CLIENT_SECRET"),
      env: env("PAYPAL_ENV", "sandbox") as "sandbox" | "live",
      webhookId: env("PAYPAL_WEBHOOK_ID"),
    },
    stellar: {
      network: env("STELLAR_NETWORK", "testnet") as "testnet" | "public",
      horizonUrl: env("STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org"),
      /** Treasury account that pays out. Secret never leaves the server. */
      treasurySecret: env("STELLAR_TREASURY_SECRET"),
      /** PYUSD issuer on the chosen network. Testnet issuer verified on Horizon testnet 2026-10-03 (1,395 holders). Mainnet: GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5. Override via env; STELLAR_NETWORK=public refuses the testnet issuer. */
      pyusdIssuer: env("STELLAR_PYUSD_ISSUER", TESTNET_PYUSD_ISSUER),
      pyusdCode: env("STELLAR_PYUSD_CODE", "PYUSD"),
    },
  },

  ai: {
    mode: (env("AI_MODE", "mock") as AiMode),
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    model: env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
  },

  accounting: {
    destination: env("ACCOUNTING_DESTINATION", "csv") as "csv" | "xero",
    xero: {
      clientId: env("XERO_CLIENT_ID"),
      clientSecret: env("XERO_CLIENT_SECRET"),
    },
  },
} as const;

export function isLiveRails(): boolean {
  return config.rails.mode === "live";
}

/** Real money: live rails pointed at PayPal live or the Stellar public network. Sandbox and testnet are not real money. */
export function isRealMoney(): boolean {
  return isLiveRails() && (config.rails.paypal.env === "live" || config.rails.stellar.network === "public");
}
export function isLiveAi(): boolean {
  return config.ai.mode === "live" && config.ai.anthropicApiKey.length > 0;
}
