import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Field encryption for the few values that must be stored whole: vendor bank account numbers, which Wise and the
 * bank file need in full. AES-256-GCM with a random IV per value; the key comes from CHECKRAIL_DATA_KEY (32 bytes,
 * base64 or hex) and never touches the database. Screens and the audit log only ever see the last four digits.
 *
 * Without a key, a fixed and public development key is used only on a development server or the simulated hosted
 * demo; anywhere else (live rails, sandbox included, or a production server), storing or reading a full account
 * number refuses.
 */

const PREFIX = "v1";
const DEV_KEY = createHash("sha256").update("checkrail-pay development key: never protects real data").digest();

/**
 * Where a real key is required: any live rail (sandbox and testnet included, since testers type real-looking account
 * numbers there), live provider environments, and any production server that is not the simulated demo. Only a
 * development server, or the hosted demo on simulated rails with demo personas, may use the public development key.
 */
function realKeyRequired(): boolean {
  if (process.env.RAIL_MODE === "live" || process.env.PAYPAL_ENV === "live" || process.env.STELLAR_NETWORK === "public" || process.env.WISE_ENV === "live") return true;
  return process.env.NODE_ENV === "production" && process.env.CHECKRAIL_DEMO_PERSONAS !== "1" && process.env.CHECKRAIL_INSECURE_DEMO !== "1";
}

function key(): Buffer {
  const raw = process.env.CHECKRAIL_DATA_KEY?.trim();
  if (raw) {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
    // Any other secret (a host-generated value, a passphrase) is stretched to 32 bytes; it must be long enough to matter.
    if (raw.length < 24) throw new Error("CHECKRAIL_DATA_KEY is too short: use 32 random bytes, base64 or hex");
    return createHash("sha256").update(raw).digest();
  }
  if (realKeyRequired()) throw new Error("CHECKRAIL_DATA_KEY is not set: full bank account numbers cannot be stored or read here. Generate one with: openssl rand -base64 32");
  if (!warned && process.env.NODE_ENV !== "test") {
    warned = true;
    console.warn("[checkrail] CHECKRAIL_DATA_KEY is not set: bank account numbers are encrypted with the public development key. Fine for a mock demo; set a random key before storing anyone's real account.");
  }
  return DEV_KEY;
}

let warned = false;

export function usingDevKey(): boolean {
  return !process.env.CHECKRAIL_DATA_KEY?.trim();
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [PREFIX, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptField(stored: string): string {
  const [v, iv, tag, ct] = stored.split(":");
  if (v !== PREFIX || !iv || !tag || !ct) throw new Error("Unreadable encrypted value");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** "****6789" for screens and logs. */
export function lastFour(accountNumber: string): string {
  return `****${accountNumber.replace(/\D/g, "").slice(-4)}`;
}
