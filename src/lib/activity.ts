import { humaniseActor, railLabel } from "./format";

/**
 * The overview's Live activity: one row per event a person cares about (blocked, held for approval, approved, paid,
 * scheduled by autopilot, cancelled, came back), with the vendor, the reference and a short reason. The full chain
 * (reading, rule checks, routing, accounting) stays in the audit log.
 */

export type ActivityKind = "blocked" | "held" | "evidence" | "cleared" | "approved" | "paid" | "scheduled" | "sent_by_agent" | "release_cancelled" | "cancelled" | "came_back" | "failed" | "stopped";

export interface ActivityRow {
  id: string;
  obligationId: string;
  kind: ActivityKind;
  vendorName: string | null;
  sourceRef: string | null;
  /** "held for approval: above USD 250" */
  text: string;
  tone: "blocked" | "attention" | "settled" | "neutral";
  at: string;
}

export interface AuditLike {
  id: string;
  seq: number;
  obligationId: string | null;
  actor: string;
  action: string;
  createdAt: string;
  vendorName: string | null;
  sourceRef: string | null;
  detail: Record<string, unknown> | null;
}

const firstReason = (d: Record<string, unknown> | null): string | null => {
  const r = d?.reasons;
  return Array.isArray(r) && typeof r[0] === "string" ? r[0] : typeof d?.reason === "string" ? d.reason : null;
};

const money = (s: string) => s.replace(/\.00$/, "");

/** The policy engine's reason, cut to what fits on one line of the overview. The full sentence is on the request. */
export function shortReason(reason: string | null): string | null {
  if (!reason) return null;
  const r = reason.replace(/^New since approval: /, "");
  let m: RegExpMatchArray | null;
  if ((m = r.match(/auto-execute threshold ([A-Z]{3} [\d,.]+)/))) return `above ${money(m[1])}`;
  if ((m = r.match(/autopilot per-payment cap ([A-Z]{3} [\d,.]+)/))) return `above the ${money(m[1])} autopilot cap`;
  if ((m = r.match(/above the ([A-Z]{3} [\d,.]+) autopilot daily cap/))) return `over the ${money(m[1])} autopilot daily cap`;
  if ((m = r.match(/dual-approval threshold ([A-Z]{3} [\d,.]+)/))) return `above ${money(m[1])}, two people approve`;
  if ((m = r.match(/^Requested ([A-Z]{3} [\d,.]+) but (.+?) says ([A-Z]{3} [\d,.]+)/))) return `asks ${money(m[1])}, ${m[2]} says ${money(m[3])}`;
  if ((m = r.match(/^Rate card and departure (\S+) say ([A-Z]{3} [\d,.]+).*this asks for ([A-Z]{3} [\d,.]+)/))) return `asks ${money(m[3])}, rate card for ${m[1]} says ${money(m[2])}`;
  if ((m = r.match(/^Reference (\S+) was already used/))) return `${m[1]} was already paid`;
  if (/^Same job as/.test(r)) return "same job as a payment already made";
  if (/^Only the vendor's own documents/.test(r)) return "only the vendor's own documents support it";
  if (/review everything/.test(r)) return "every payment is reviewed";
  if (/^First payment to this vendor/.test(r)) return "first payment to this vendor";
  if (/times this vendor's usual/.test(r)) return "far above what this vendor is usually paid";
  if (/payout details changed|never verified/i.test(r)) return "payout details not verified";
  if (/^No supporting evidence/.test(r)) return "no evidence attached";
  if (/does not name|confirm the payee|only by part of the name/.test(r)) return "confirm who is being paid";
  if (/Payments to this vendor in the last 24h/.test(r)) return "over this vendor's daily limit";
  if (/No W-8BEN/.test(r)) return "tax form missing";
  if (/Agent confidence/.test(r)) return "the agent was not sure";
  return r.length > 80 ? `${r.slice(0, 78).trimEnd()}…` : r;
}

/**
 * A policy reason as a full, plain sentence for the Needs you list and the Daily close (DS2-16): what the rule found
 * and who acts, without engine wording ("auto-execute threshold") or internal ids.
 */
export function plainReason(reason: string | null | undefined): string {
  if (!reason) return "";
  const fresh = /^New since approval: /.test(reason);
  const r = reason.replace(/^New since approval: /, "");
  let m: RegExpMatchArray | null;
  let out: string;
  if ((m = r.match(/^Amount exceeds auto-execute threshold ([A-Z]{3} [\d,.]+)/))) out = `Above ${money(m[1])}: a person approves`;
  else if ((m = r.match(/^Amount exceeds dual-approval threshold ([A-Z]{3} [\d,.]+)/))) out = `Above ${money(m[1])}: two people approve`;
  else if ((m = r.match(/^Amount exceeds the autopilot per-payment cap ([A-Z]{3} [\d,.]+)/))) out = `Above the ${money(m[1])} autopilot cap: a person approves`;
  else if ((m = r.match(/above the ([A-Z]{3} [\d,.]+) autopilot daily cap/))) out = `Over the ${money(m[1])} autopilot daily cap: a person approves`;
  else if (/^Only the vendor's own documents/.test(r)) out = "Only the vendor's own invoice supports the amount: a person approves";
  else if (/^First payment to this vendor/.test(r)) out = "First payment to this vendor: a person approves";
  else if (/times this vendor's usual/.test(r)) out = `${r.split(":")[0]}: a person approves`;
  else if (/review everything/.test(r)) out = "You review every payment";
  else out = r.replace(/\b(?:obligation|payment request) obl_[a-z0-9]+ \((\w+)\)/gi, "an earlier request ($1)").replace(/\b(?:obligation|payment request) obl_[a-z0-9]+/gi, "an earlier request").replace(/\bobl_[a-z0-9]+/gi, "an earlier request");
  return fresh ? `New since approval: ${out.charAt(0).toLowerCase()}${out.slice(1)}` : out;
}

/** How close together the agent's send and its settlement must be to read as one moment. */
const MOMENT_MS = 2 * 60_000;

/**
 * Newest first, at most `limit` rows. `entries` is the audit log newest first (as listAudit returns it).
 * A policy clearance right after a person's approval is the same moment, so only the approval is shown.
 */
export function activityFeed(entries: AuditLike[], limit = 10): ActivityRow[] {
  const ascending = [...entries].filter((e) => e.obligationId).sort((a, b) => a.seq - b.seq);
  // A person's approval followed by policy clearing it is one moment: the approval is the row.
  const approvedPending = new Set<string>();
  const rows: ActivityRow[] = [];
  for (const e of ascending) {
    const who = humaniseActor(e.actor);
    const row = (kind: ActivityKind, text: string, tone: ActivityRow["tone"]) =>
      rows.push({ id: e.id, obligationId: e.obligationId!, kind, vendorName: e.vendorName, sourceRef: e.sourceRef, text, tone, at: e.createdAt });
    const why = shortReason(firstReason(e.detail));
    switch (e.action) {
      case "policy.block":
        row("blocked", why ? `blocked: ${why}` : "blocked", "blocked");
        break;
      case "policy.require_approval":
        row("held", why ? `held for approval: ${why}` : "held for approval", "attention");
        break;
      case "policy.hold":
        row("evidence", "waiting for evidence", "attention");
        break;
      case "policy.auto_execute":
        if (approvedPending.has(e.obligationId!)) approvedPending.delete(e.obligationId!);
        else row("cleared", "passed the rules, nobody needed to approve", "neutral");
        break;
      case "approval.granted":
        approvedPending.add(e.obligationId!);
        row("approved", `approved by ${who}`, "neutral");
        break;
      case "settlement.confirmed": {
        const rail = e.actor.startsWith("rail:") ? railLabel(e.actor.slice(5)) : null;
        row("paid", rail ? `paid over ${rail}` : "paid", "settled");
        break;
      }
      case "autopilot.scheduled":
        row("scheduled", "scheduled by autopilot, can be cancelled until it sends", "attention");
        break;
      case "autopilot.releasing":
        row("sent_by_agent", "sent by autopilot", "neutral");
        break;
      case "autopilot.cancelled":
        row("release_cancelled", `autopilot release cancelled by ${who}`, "neutral");
        break;
      case "autopilot.refused":
        row("stopped", why ? `stopped at the last check: ${why}` : "stopped at the last check", "blocked");
        break;
      case "approval.rejected":
      case "obligation.cancelled":
        row("cancelled", `cancelled by ${who}`, "neutral");
        break;
      case "settlement.returned":
      case "bank_file.line_returned":
        row("came_back", "came back, not paid twice", "blocked");
        break;
      case "execution.failed":
      case "settlement.failed":
        row("failed", "payment failed", "blocked");
        break;
      default:
        break;
    }
  }
  return storyOrder(rows).slice(0, limit);
}

/**
 * Newest first, except that the agent's send and its outcome read as one story, in audit sequence: "sent by
 * autopilot" above "paid over PayPal", not below it with the same "just now" (DS2-28). `rows` is in audit order.
 */
function storyOrder(rows: ActivityRow[]): ActivityRow[] {
  const OUTCOME = new Set<ActivityKind>(["paid", "failed", "came_back"]);
  const groups: ActivityRow[][] = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    const head = g?.[0];
    if (head && head.kind === "sent_by_agent" && head.obligationId === r.obligationId && OUTCOME.has(r.kind) && Math.abs(new Date(r.at).getTime() - new Date(head.at).getTime()) <= MOMENT_MS) g.push(r);
    else groups.push([r]);
  }
  return groups.reverse().flat();
}
