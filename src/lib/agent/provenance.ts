import { AgentInputError } from "./errors";

/**
 * Instruction provenance: a prompt-injection firewall for money.
 *
 * An agent that reads email, web pages and documents can be told to pay by text that nobody at the business wrote:
 * a supplier's email with hidden lines, a web page, a forwarded PDF. The agent says where the instruction to pay came
 * from, and where each key fact came from (payee, amount, payout details, reference). Checkrail then:
 *
 *  - refuses outright payout details an agent says came from anywhere but the supplier portal, and holds those it says
 *    came from the portal. An agent never changes where money goes: payout details change only through the verified
 *    supplier flow (the supplier's own link, checked by a second person);
 *  - holds for a person an instruction that traces to an outside email, the web or a source the agent cannot name;
 *  - holds for a person a payee or amount whose only source is outside content;
 *  - passes system-of-record and owner-chat sources (and internal email, the supplier portal and documents) through to
 *    the normal rules, which still decide.
 *
 * All of this happens in the agent layer, before the request reaches ingest. A hold is one of the agent's own concerns
 * (`stated.flags`, see engine/orchestrator.ts), which policy turns into a warning a person must clear. Without
 * provenance nothing changes, and the answer says provenance is supported.
 *
 * Provenance is self-asserted. It protects a cooperative agent; it can only add holds, never relax a rule.
 */

export const SOURCE_KINDS = ["owner_chat", "system_of_record", "vendor_portal", "email_internal", "email_external", "web", "document", "unknown"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const FACTS = ["payee", "amount", "payout_details", "reference"] as const;
export type Fact = (typeof FACTS)[number];

export interface Source {
  kind: SourceKind;
  label: string | null;
  /** For an outside source: the sender's address or the site's domain, as the agent saw it. */
  sender: string | null;
}

export interface Provenance {
  instruction: Source;
  facts: Partial<Record<Fact, Source[]>>;
}

/** Content nobody at the business wrote or checked. */
export const OUTSIDE: ReadonlySet<SourceKind> = new Set(["email_external", "web", "unknown"]);
/** The business's own word. */
export const TRUSTED: ReadonlySet<SourceKind> = new Set(["owner_chat", "system_of_record"]);

/** Short labels for the pills on the Agents page and the request page. */
export const KIND_LABEL: Record<SourceKind, string> = {
  owner_chat: "Owner chat",
  system_of_record: "System of record",
  vendor_portal: "Supplier portal",
  email_internal: "Internal email",
  email_external: "Outside email",
  web: "Web",
  document: "Document",
  unknown: "Unknown",
};

export const FACT_LABEL: Record<Fact | "instruction", string> = { instruction: "Instruction", payee: "Payee", amount: "Amount", payout_details: "Payout details", reference: "Reference" };

export const PROVENANCE_HINT =
  "Checkrail also takes provenance: where the instruction to pay came from and where the payee, amount, payout details and reference came from (owner_chat, system_of_record, vendor_portal, email_internal, email_external, web, document, unknown). An instruction from an outside email or the web is held for a person, and payout details are never taken from an agent. It can only add holds: it never relaxes a rule.";

// ---------- Input ----------

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,120}\.[A-Za-z]{2,24}$/;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24}$/;

/** An address or a domain, nothing else: it is echoed back to the agent and shown to people, so it carries no prose. */
function senderOf(v: unknown, where: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new AgentInputError(`${where}.sender must be a string`);
  let t = v.trim().replace(/^mailto:/i, "");
  if (/^https?:\/\//i.test(t)) {
    try {
      t = new URL(t).hostname;
    } catch {
      throw new AgentInputError(`${where}.sender must be an email address or a domain`);
    }
  }
  t = t.replace(/^www\./i, "").toLowerCase();
  if (t.length > 120 || !(EMAIL.test(t) || DOMAIN.test(t))) throw new AgentInputError(`${where}.sender must be an email address or a domain, such as billing@example.com or example.com`);
  return t;
}

function labelOf(v: unknown, where: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new AgentInputError(`${where}.label must be a string`);
  const t = v.replace(/[\u0000-\u001f\u007f\u200B-\u200D\u2060\uFEFF]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > 80) throw new AgentInputError(`${where}.label must be at most 80 characters`);
  return t || null;
}

function sourceOf(v: unknown, where: string): Source {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AgentInputError(`${where} must be an object with a kind`);
  const r = v as Record<string, unknown>;
  if (typeof r.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(r.kind)) throw new AgentInputError(`${where}.kind must be one of ${SOURCE_KINDS.join(", ")}`);
  return { kind: r.kind as SourceKind, label: labelOf(r.label, where), sender: senderOf(r.sender, where) };
}

/** The `provenance` argument, checked; null when the agent sent none. */
export function validateProvenance(raw: unknown): Provenance | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AgentInputError("provenance must be an object with an instruction source");
  const r = raw as Record<string, unknown>;
  const instruction = sourceOf(r.instruction, "provenance.instruction");
  const facts: Provenance["facts"] = {};
  if (r.facts !== undefined && r.facts !== null) {
    if (typeof r.facts !== "object" || Array.isArray(r.facts)) throw new AgentInputError("provenance.facts must be an object keyed by payee, amount, payout_details or reference");
    for (const [k, v] of Object.entries(r.facts as Record<string, unknown>)) {
      if (!(FACTS as readonly string[]).includes(k)) throw new AgentInputError(`provenance.facts.${k.slice(0, 30)} is not a fact Checkrail reads; use ${FACTS.join(", ")}`);
      const list = Array.isArray(v) ? v : [v];
      if (list.length === 0 || list.length > 5) throw new AgentInputError(`provenance.facts.${k} must list one to five sources`);
      facts[k as Fact] = list.map((s, i) => sourceOf(s, `provenance.facts.${k}[${i}]`));
    }
  }
  return { instruction, facts };
}

// ---------- Rules ----------

/** Where something came from, in words: "an outside email (billing@phuong-transport.vn)". */
export function described(s: Source): string {
  const who = s.sender ? ` (${s.sender})` : "";
  switch (s.kind) {
    case "email_external":
      return `an outside email${who}`;
    case "web":
      return `a web page${who}`;
    case "unknown":
      return "a source the agent could not name";
    case "owner_chat":
      return "the owner's chat";
    case "system_of_record":
      return `the business's own system${s.label ? ` (${s.label})` : ""}`;
    case "vendor_portal":
      return "the supplier portal";
    case "email_internal":
      return `an internal email${who}`;
    case "document":
      return `a document${s.label ? ` (${s.label})` : ""}`;
  }
}

export interface ProvenanceFinding {
  /** Refuse outright: a payout-detail change from anywhere but the verified supplier flow. */
  refusal: string | null;
  /** Each a hold for a person, written for the person and the agent alike. At most two. */
  holds: string[];
}

const listed = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * What the provenance means for this payment.
 *
 * Provenance is the agent's own word. It protects a cooperative agent that reports honestly; a hijacked agent can leave
 * it out or claim owner_chat or system_of_record. So it can only add holds and refusals: it never relaxes a rule, and
 * a check with any provenance is never easier to pass than the same check without it (review AF-2).
 *
 * Payout details are never accepted from an agent, whatever it claims. There is no agent path that changes where money
 * goes: payouts go only to the details on file, which change only through the verified supplier flow (the supplier's
 * own link, checked by a second person). Payout details an agent says came from anywhere else are refused; payout
 * details it says came from the supplier portal are held, since that claim is unverified too.
 * A payee or amount with mixed sources (the booking system and an email) is not held for its source.
 * At most two holds come back, so the cap on an agent's concerns never drops another one.
 */
export function assessProvenance(p: Provenance | null): ProvenanceFinding {
  if (!p) return { refusal: null, holds: [] };
  const payout = p.facts.payout_details ?? [];
  const foreign = payout.find((s) => s.kind !== "vendor_portal");
  const refusal = foreign
    ? `this instruction gives payout details from ${described(foreign)}. Checkrail never takes payout details from an agent: a supplier changes them only through the verified supplier flow, checked by a second person`
    : null;
  // Most telling first. Any one of them holds the payment, so a third adds only words and is left off.
  const holds: string[] = [];
  if (OUTSIDE.has(p.instruction.kind)) holds.push(`This instruction came from ${described(p.instruction)}. A person confirms it.`);
  if (!foreign && payout.length > 0) holds.push(PORTAL_PAYOUT_HOLD);
  const onlyOutside = (["payee", "amount"] as const).filter((f) => (p.facts[f] ?? []).length > 0 && p.facts[f]!.every((s) => OUTSIDE.has(s.kind)));
  if (onlyOutside.length) {
    const from = [...new Set(onlyOutside.flatMap((f) => p.facts[f]!.map(described)))];
    holds.push(`The ${listed(onlyOutside.map((f) => (f === "payee" ? "payee" : "amount")))} came only from ${listed(from.slice(0, 2))}. A person confirms ${onlyOutside.length === 1 ? "it" : "them"}.`);
  }
  return { refusal, holds: holds.slice(0, 2) };
}

const PORTAL_PAYOUT_HOLD = "The agent says payout details came from the supplier portal. Checkrail never takes payout details from an agent and pays only the details on file. A person confirms it.";

/**
 * A message shaped like one of these holds. On its own it proves nothing: the reader could write such a sentence. The
 * guard treats a warning as its own provenance hold only when it is also one it added itself (review AF-12).
 */
export function isProvenanceHold(message: string): boolean {
  return message === PORTAL_PAYOUT_HOLD || /^This instruction came from .+\. A person confirms it\.$/.test(message) || /^The (?:payee|amount|payee and amount) came only from .+\. A person confirms (?:it|them)\.$/.test(message);
}

// ---------- Display ----------

/**
 * The pill tone for a source: attention for outside content, neutral for everything else. Never the green "settled"
 * tone: an owner_chat or system_of_record claim is the agent's own word, not a cleared check (review AF2 nit).
 */
export const pillTone = (l: Pick<ProvenanceLine, "outside">): "attention" | "neutral" => (l.outside ? "attention" : "neutral");

export interface ProvenanceLine {
  what: string;
  kind: SourceKind;
  kindLabel: string;
  detail: string | null;
  outside: boolean;
  trusted: boolean;
}

/** One line per source, instruction first, for the Agents page and the request page. */
export function provenanceLines(json: string | null | undefined): ProvenanceLine[] {
  if (!json) return [];
  let p: Provenance;
  try {
    p = JSON.parse(json) as Provenance;
  } catch {
    return [];
  }
  if (!p?.instruction?.kind) return [];
  const line = (what: string, s: Source): ProvenanceLine => ({
    what,
    kind: s.kind,
    kindLabel: KIND_LABEL[s.kind] ?? s.kind,
    detail: [s.label, s.sender].filter(Boolean).join(", ") || null,
    outside: OUTSIDE.has(s.kind),
    trusted: TRUSTED.has(s.kind),
  });
  // One line per source: facts that came from the same source share its line ("Payee, amount and reference").
  const groups: Array<{ s: Source; what: string[] }> = [{ s: p.instruction, what: [FACT_LABEL.instruction] }];
  const same = (a: Source, b: Source) => a.kind === b.kind && (a.label ?? null) === (b.label ?? null) && (a.sender ?? null) === (b.sender ?? null);
  for (const f of FACTS) {
    const v = p.facts?.[f] as Source[] | Source | undefined;
    for (const s of Array.isArray(v) ? v : v ? [v] : []) {
      if (!s?.kind) continue;
      const g = groups.find((x) => same(x.s, s));
      if (g) g.what.push(FACT_LABEL[f].toLowerCase());
      else groups.push({ s, what: [FACT_LABEL[f]] });
    }
  }
  return groups.slice(0, 12).map((g) => line(listed(g.what), g.s));
}
