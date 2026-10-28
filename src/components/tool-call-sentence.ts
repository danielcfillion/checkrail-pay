import { formatDate, formatMoney } from "@/lib/format";

/** What the page knows about the request, so a tool call can be described in its terms. */
export type ToolCallContext = { vendorName?: string | null; sourceRef?: string | null; evidenceCount?: number; documentCount?: number };

type Call = { name: string; input: string; resultPreview: string };

/** Input and preview are stored as clipped strings (200 characters), so fields are read with patterns, not JSON.parse. */
const field = (s: string, key: string): string | null => {
  const m = s.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : null;
};
const numField = (s: string, key: string): number | null => {
  const m = s.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`));
  return m ? Number(m[1]) : null;
};
const errorOf = (preview: string): string | null => {
  if (!/^\s*\{\s*"error"/.test(preview)) return null;
  return field(preview, "error") ?? "error";
};
const complete = (s: string): boolean => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One plain sentence per agent tool call: what the agent looked at and what came back.
 * The sentence only states what the stored preview shows; anything it cannot see stays neutral.
 */
export function toolCallSentence(call: Call, ctx: ToolCallContext = {}): string {
  const input = call.input ?? "";
  const out = call.resultPreview ?? "";
  const err = errorOf(out);
  const failed = (what: string) => `${what}: the call failed (${err})`;

  switch (call.name) {
    case "lookup_vendor": {
      const query = field(input, "query") ?? ctx.vendorName ?? "the payee";
      if (err) return failed(`Looked up ${query}`);
      if (/^\s*\[\s*\]/.test(out)) return `Looked up ${query}: no vendor on file`;
      const names = [...out.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
      if (names.length > 1) return `Looked up ${query}: ${names.length} vendors match (${names.join(", ")})`;
      const bank = field(out, "bank");
      const verified = field(out, "verifiedAt");
      const parts = ["known vendor"];
      if (bank) parts.push(bank);
      if (verified) parts.push(`payout details verified ${formatDate(verified)}`);
      return `Looked up ${names[0] ?? query}: ${parts.join(", ")}`;
    }
    case "read_evidence": {
      if (err) return failed("Read the attached records");
      const n = ctx.evidenceCount ?? (out.match(/"kind"\s*:/g) ?? []).length;
      const docs = ctx.documentCount ?? 0;
      if (n === 0 && docs === 0) return "Read the attached records: none attached";
      return `Read the attached records: ${plural(n, "record")}${docs ? ` and ${plural(docs, "document")}` : ""}`;
    }
    case "vendor_history": {
      const who = ctx.vendorName ? `${ctx.vendorName}'s` : "the vendor's";
      if (err) return failed(`Checked ${who} payment history`);
      if (/^\s*\[\s*\]/.test(out)) return `Checked ${who} payment history: no earlier payments`;
      const ref = field(out, "sourceRef");
      const amount = numField(out, "amountMinor");
      const currency = field(out, "currency");
      const latest = ref ? `, including ${ref}${amount !== null && currency ? ` (${formatMoney(amount, currency)})` : ""}` : "";
      return `Checked ${who} payment history: earlier payments on file${latest}`;
    }
    case "paypal_list_transactions": {
      const ref = ctx.sourceRef;
      const what = `Checked PayPal transactions${ref ? ` for ${ref}` : ""}`;
      if (err) return failed(what);
      if (/"transaction_details"\s*:\s*\[\s*\]/.test(out) || /"total_items"\s*:\s*0\b/.test(out)) return `${what}: no transactions in the period`;
      if (ref && out.toLowerCase().includes(ref.toLowerCase())) return `${what}: a transaction mentions ${ref}`;
      const total = numField(out, "total_items");
      // Only a complete result can show that nothing matches; a clipped preview might hide the match.
      if (ref && complete(out)) return `Checked PayPal transactions: no earlier payment for ${ref}${total !== null ? ` in ${plural(total, "transaction")}` : ""}`;
      return total !== null ? `${what}: ${plural(total, "transaction")} in the period read` : `${what}: transactions read`;
    }
    case "paypal_list_invoices": {
      if (err) return failed("Listed PayPal invoices");
      if (/"items"\s*:\s*\[\s*\]/.test(out) || /"total_items"\s*:\s*0\b/.test(out)) return "Listed PayPal invoices: none on file";
      const total = numField(out, "total_items");
      return total !== null ? `Listed PayPal invoices: ${plural(total, "invoice")} on file` : "Listed PayPal invoices";
    }
    case "paypal_get_invoice": {
      const id = field(input, "invoice_id") ?? "an invoice";
      if (err) return failed(`Fetched PayPal invoice ${id}`);
      const status = field(out, "status");
      return `Fetched PayPal invoice ${id}${status ? `: status ${status.replace(/_/g, " ").toLowerCase()}` : ""}`;
    }
    default:
      return err ? failed(`Called ${call.name}`) : `Called ${call.name.replace(/_/g, " ")}`;
  }
}
