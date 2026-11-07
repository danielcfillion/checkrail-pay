/**
 * Try it yourself: the three sample requests. Pure data, shared by the page, the server actions and the tests.
 *
 * Each sample names a payee, rate card and departure that the demo seed holds (src/lib/demo/seed.ts), and a document
 * in public/demo-documents that the PDF reader reads as the evidence:
 *  - clean:      Rosa's 2 days on departure CEB-2D-1029 at her USD 95 day rate. Passes, under the USD 250 line, paid.
 *  - overcharge: Phuong asks USD 1,100 for HG-4D-1026; the trip sheet and rate card say 4 vehicle-days at USD 200.
 *  - repeat:     Phuong's INV-2026-0138, already paid 12 days before the demo opens.
 * Names, companies and amounts are invented.
 */

export type SampleId = "clean" | "overcharge" | "repeat";

export interface TrySample {
  id: SampleId;
  /** The picker's name for it. */
  name: string;
  /** One line: what the judge will see happen. */
  expect: string;
  payee: string;
  /** Major units, as typed, for example "1100" or "190.00". */
  amount: string;
  currency: "USD";
  reference: string;
  /** What else the message says, after who, what and how much. */
  context: string;
  /** The document a clerk attaches, served from /demo-documents. */
  document: { file: string; label: string; says: string };
  /** What a person does at step 4 in auto mode. */
  decision: "none" | "correct" | "reject";
}

export const TRY_SAMPLES: readonly TrySample[] = [
  {
    id: "clean",
    name: "A clean guide fee",
    expect: "Matches the rate card: passes, then is approved and paid.",
    payee: "Rosa Villanueva",
    amount: "190",
    currency: "USD",
    reference: "JOB-CEB2D-1029",
    context: "Trip CEB-2D-1029 closed, 2 days guiding. Trip sheet attached.",
    document: { file: "tripsheet-ceb2d-1029.pdf", label: "Trip sheet CEB-2D-1029", says: "2 days at USD 95.00, total USD 190.00" },
    decision: "none",
  },
  {
    id: "overcharge",
    name: "A driver asks too much",
    expect: "USD 1,100 against a trip sheet for USD 800: blocked, with Correct to USD 800.",
    payee: "Phuong Transport",
    amount: "1100",
    currency: "USD",
    reference: "INV-2026-0171",
    context: "Van and driver for the Ha Giang loop HG-4D-1026. Needs it today for fuel.",
    document: { file: "tripsheet-hg4d-1026.pdf", label: "Trip sheet HG-4D-1026", says: "4 vehicle-days at USD 200.00, total USD 800.00" },
    decision: "correct",
  },
  {
    id: "repeat",
    name: "An invoice paid before",
    expect: "INV-2026-0138 was paid 12 days ago: blocked as a duplicate.",
    payee: "Phuong Transport",
    amount: "600",
    currency: "USD",
    reference: "INV-2026-0138",
    context: "Van hire, 3 days. Invoice attached.",
    document: { file: "invoice-phuong-0138.pdf", label: "Invoice INV-2026-0138", says: "3 days at USD 200.00, total USD 600.00" },
    decision: "reject",
  },
];

export function sampleById(id: string): TrySample | null {
  return TRY_SAMPLES.find((s) => s.id === id) ?? null;
}

/** The judge's own fields. Starts as a copy of the sample; any of them can be typed over. */
export interface TryFields {
  payee: string;
  amount: string;
  reference: string;
  /** The request as the clerk received it. Written from the other fields until the judge types in it. */
  text: string;
  /** True once the judge typed in the request text: it is then theirs and the other fields no longer rewrite it. */
  textEdited: boolean;
}

/** "1100" as "1,100", "190.5" as "190.50": how the request text spells an amount. */
export function spellAmount(raw: string): string {
  const n = parseAmountMinor(raw);
  if (n === null) return raw.trim();
  const major = Math.floor(n / 100);
  const minor = n % 100;
  return `${major.toLocaleString("en-US")}${minor ? `.${String(minor).padStart(2, "0")}` : ""}`;
}

/** The request text a clerk would receive, from the fields. */
export function composeRequest(s: Pick<TrySample, "context" | "currency">, f: Pick<TryFields, "payee" | "amount" | "reference">): string {
  const who = f.payee.trim() || "the supplier";
  const ref = f.reference.trim();
  return `Please pay ${who}${ref ? ` ${ref}` : ""}, ${s.currency} ${spellAmount(f.amount)}. ${s.context}`;
}

export function fieldsFor(s: TrySample): TryFields {
  const base = { payee: s.payee, amount: s.amount, reference: s.reference };
  return { ...base, text: composeRequest(s, base), textEdited: false };
}

/** A typed field changed: the request text follows it unless the judge wrote the text themselves. */
export function editField(s: TrySample, f: TryFields, key: "payee" | "amount" | "reference" | "text", value: string): TryFields {
  if (key === "text") return { ...f, text: value, textEdited: true };
  const next = { ...f, [key]: value };
  return next.textEdited ? next : { ...next, text: composeRequest(s, next) };
}

/** Major units typed by a person ("1,100", "800.00") in minor units, or null when it is not an amount. */
export function parseAmountMinor(raw: string): number | null {
  const t = raw.replace(/[,\s]/g, "").replace(/^(USD|\$)/i, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [a, b = ""] = t.split(".");
  return Number(a) * 100 + Number((b + "00").slice(0, 2));
}
