/**
 * Runtime configuration. Everything external has a mock mode so the demo
 * replays deterministically and the app runs with zero credentials.
 */

export type RailMode = "mock" | "live";
export type AiMode = "mock" | "live";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  appName: "Dueline",
  tagline: "Verified supplier payments, routed and reconciled automatically.",
  dbPath: env("DATABASE_PATH", "./data/dueline.sqlite"),

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
      /** PYUSD issuer on the chosen network. Testnet issuer from Paxos docs; override via env. */
      pyusdIssuer: env("STELLAR_PYUSD_ISSUER", "GBBK7XPX7Y6QJJ3WTUHZ2DOEAHWAWPKWBWLLZ6ILK7ZHTVPWKOEPQPSB"),
      pyusdCode: env("STELLAR_PYUSD_CODE", "PYUSD"),
    },
  },

  ai: {
    mode: (env("AI_MODE", "mock") as AiMode),
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    model: env("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
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
export function isLiveAi(): boolean {
  return config.ai.mode === "live" && config.ai.anthropicApiKey.length > 0;
}
