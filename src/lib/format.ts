/**
 * Pure presentation helpers for the dashboard. No DB, no business logic.
 */

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XOF", "XAF"]);

/** Decimal places the currency is normally shown with. Minor units in the DB are always cents (x100). */
export function currencyDecimals(currency: string | null | undefined): number {
  return ZERO_DECIMAL.has((currency ?? "").toUpperCase()) ? 0 : 2;
}

/** "USD 960.00" for body text, or "960.00" without the code. */
export function formatMoney(minor: number | null | undefined, currency: string | null | undefined, opts: { code?: boolean } = {}): string {
  if (minor === null || minor === undefined) return "";
  const cur = (currency ?? "USD").toUpperCase();
  const decimals = currencyDecimals(cur);
  const value = minor / 100;
  const s = value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return opts.code === false ? s : `${cur} ${s}`;
}

/** "$960.00" for the big figures; symbol only for a few well known codes, otherwise code prefix. */
export function formatMoneySymbol(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  const cur = (currency ?? "USD").toUpperCase();
  const symbols: Record<string, string> = { USD: "$", PHP: "₱", VND: "₫", THB: "฿", EUR: "€", GBP: "£", CAD: "CA$" };
  const sym = symbols[cur];
  const body = formatMoney(minor, cur, { code: false });
  return sym ? `${sym}${body}` : `${cur} ${body}`;
}

export function formatFxRate(rate: string | null | undefined): string {
  if (!rate) return "";
  const n = Number(rate);
  if (!Number.isFinite(n) || n === 0) return "";
  if (n === 1) return "1.00 (no FX)";
  return n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** "about 15 minutes", "1 to 2 days". */
export function humaniseEta(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(seconds / 86400);
  if (days <= 1) return "about 1 day";
  return `${days - 1} to ${days} days`;
}

/** "2 hours ago", "17 days ago", "in 3 days". */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  let out: string;
  if (s < 45) out = "just now";
  else if (s < 90) out = "1 minute";
  else if (s < 3600) out = `${Math.round(s / 60)} minutes`;
  else if (s < 7200) out = "1 hour";
  else if (s < 86400) out = `${Math.round(s / 3600)} hours`;
  else if (s < 172800) out = "1 day";
  else if (s < 30 * 86400) out = `${Math.round(s / 86400)} days`;
  else if (s < 60 * 86400) out = "1 month";
  else out = `${Math.round(s / (30 * 86400))} months`;
  if (out === "just now") return out;
  return future ? `in ${out}` : `${out} ago`;
}

/**
 * The business's own time zone. Times are stored in UTC and shown in this zone, and "today" means today here.
 * Set NEXT_PUBLIC_CHECKRAIL_TIMEZONE (an IANA name such as Asia/Ho_Chi_Minh or Asia/Manila) at build time.
 */
export const TIMEZONE = process.env.NEXT_PUBLIC_CHECKRAIL_TIMEZONE || "Asia/Ho_Chi_Minh";

/** "GMT+7" for the business time zone at this instant. */
export function zoneLabel(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? TIMEZONE;
}

/** Midnight today in the business time zone, as an instant. */
export function startOfLocalDay(at: Date = new Date()): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMs = asUtc - Math.floor(at.getTime() / 1000) * 1000;
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offsetMs);
}

/** "3 Oct 2026, 17:15 GMT+7" in the business time zone, for title attributes and detail panels. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE }) + " " + zoneLabel(d);
}

/** "3 Oct 2026". Accepts a date-only string too. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  if (!Number.isFinite(d.getTime())) return iso;
  // A bare date (an invoice date, a due date) has no time zone; an instant is shown as its local date.
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: iso.length === 10 ? "UTC" : TIMEZONE });
}

/** "10:15" for timelines within one obligation. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE });
}

const STATE_LABELS: Record<string, string> = {
  drafted: "Drafted",
  needs_evidence: "Needs evidence",
  verified: "Verified",
  awaiting_approval: "Awaiting approval",
  approved: "Ready to pay",
  blocked: "Blocked",
  execution_pending: "Paying",
  sent: "Sent, confirming",
  settled: "Settled",
  failed: "Failed",
  refunded: "Refunded",
  disputed: "Disputed",
  cancelled: "Cancelled",
};

export function stateLabel(state: string | null | undefined): string {
  if (!state) return "";
  return STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

const ACTION_LABELS: Record<string, string> = {
  "obligation.created": "Obligation created",
  "evidence.attached": "Evidence attached",
  "ai.interpreted": "Agent read the request",
  "policy.evaluated": "Policy rules evaluated",
  "policy.verified": "Verified against evidence",
  "policy.require_approval": "Held for approval",
  "policy.auto_execute": "Cleared to auto-pay",
  "policy.block": "Blocked by policy",
  "policy.hold": "Held for evidence",
  "route.selected": "Rail selected",
  "approval.granted": "Approved",
  "approval.rejected": "Rejected",
  "execution.started": "Payment started",
  "execution.submitted": "Payment submitted to rail",
  "execution.failed": "Payment failed",
  "settlement.confirmed": "Settlement confirmed",
  "settlement.pending": "Settlement pending",
  "settlement.checked": "Settlement checked",
  "settlement.exception": "Payout needs attention",
  "accounting.queued": "Queued for accounting",
  "accounting.exported": "Exported to accounting",
  "obligation.amended": "Obligation corrected",
  "obligation.cancelled": "Cancelled",
  "execution.refused": "Refused at the last check",
  "execution.unknown": "Outcome unclear, needs reconciling",
  "autopilot.scheduled": "Scheduled the payment",
  "autopilot.releasing": "Released the payment",
  "autopilot.refused": "Stopped at the last check",
  "autopilot.cancelled": "Cancelled the scheduled release",
  "autopilot.stood_down": "Handed the payment back to a person",
  "autopilot.paused": "Paused autopilot",
  "autopilot.resumed": "Resumed autopilot",
  "autonomy.changed": "Changed the autonomy setting",
  "daily_close.reviewed": "Signed off the daily close",
};

/** "settlement.checked:seed" -> "Settlement checked (seed)". */
export function humaniseAction(action: string | null | undefined): string {
  if (!action) return "";
  const [base, qualifier] = action.split(":");
  const label = ACTION_LABELS[base] ?? base.split(".").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ").replace(/_/g, " ");
  return qualifier ? `${label} (${qualifier.replace(/-/g, " ")})` : label;
}

/** "user:daniel" -> "Daniel", "ai:rules" -> "Agent (rules)", "rail:paypal" -> "PayPal". */
export function humaniseActor(actor: string | null | undefined): string {
  if (!actor) return "";
  const [kind, rest] = actor.split(":");
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  switch (kind) {
    case "user":
      return cap(rest ?? "operator");
    case "ai":
      return rest === "rules" ? "Agent (rules)" : "Agent";
    case "rail":
      return railLabel(rest);
    case "system":
      return rest ? `System (${rest.replace(/-/g, " ")})` : "System";
    case "agent":
      return rest === "autopilot" ? "Autopilot" : "Agent";
    case "policy":
      return "Policy";
    case "router":
      return "Router";
    default:
      return actor;
  }
}

export function railLabel(rail: string | null | undefined): string {
  if (rail === "paypal") return "PayPal";
  if (rail === "stellar") return "Stellar";
  if (rail === "wise") return "Wise";
  if (rail === "bank_file") return "Bank file";
  return rail ?? "";
}

export function sourceTypeLabel(t: string | null | undefined): string {
  switch (t) {
    case "invoice":
      return "Invoice";
    case "job_completion":
      return "Job completion";
    case "operator_instruction":
      return "Operator instruction";
    case "booking":
      return "Booking";
    default:
      return t ?? "";
  }
}

export function evidenceKindLabel(k: string | null | undefined): string {
  switch (k) {
    case "job_sheet":
      return "Job sheet";
    case "contract":
      return "Contract";
    case "booking":
      return "Booking";
    case "invoice":
      return "Invoice";
    case "message":
      return "Message";
    case "photo":
      return "Photo";
    default:
      return k ?? "";
  }
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

const COUNTRY_NAMES: Record<string, string> = { US: "United States", PH: "Philippines", VN: "Vietnam", CA: "Canada", GB: "United Kingdom" };
export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  return COUNTRY_NAMES[code.toUpperCase()] ?? code;
}

/** Extracts the evidenced amount in minor units from a blocked reason like "... says USD 800.00 ...". */
export function evidencedAmountFromReason(reason: string | null | undefined): number | null {
  if (!reason) return null;
  // "Invoice says USD 800.00" and "Rate card and departure HG-3D-1023 say VND 3,600,000": the figure the records support.
  const m = reason.match(/says? [A-Z]{3} ([\d,]+(?:\.\d{2})?)/);
  if (!m) return null;
  return Math.round(Number(m[1].replace(/,/g, "")) * 100);
}

export function truncateMiddle(s: string | null | undefined, keep = 6): string {
  if (!s) return "";
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

export function pluralise(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Today's date (YYYY-MM-DD) in the display time zone, for default names and filenames. */
export function localDateString(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
