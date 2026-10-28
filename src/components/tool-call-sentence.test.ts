import { describe, expect, it } from "vitest";
import { toolCallSentence } from "./tool-call-sentence";

const ctx = { vendorName: "Phuong Transport", sourceRef: "INV-2026-0152", evidenceCount: 2, documentCount: 0 };

describe("toolCallSentence", () => {
  it("describes a vendor lookup with the payout account", () => {
    const s = toolCallSentence(
      { name: "lookup_vendor", input: '{"query":"Phuong Transport"}', resultPreview: '[{"id":"ven_phuong","name":"Phuong Transport","country":"VN","paypal":true,"stellar":false,"bank":"Vietcombank ****7781","verifiedAt":"2026-08-14T09:00:00.000Z"}]' },
      ctx
    );
    expect(s).toBe("Looked up Phuong Transport: known vendor, Vietcombank ****7781, payout details verified 14 Aug 2026");
  });

  it("reads a clipped preview without failing", () => {
    const s = toolCallSentence({ name: "lookup_vendor", input: '{"query":"Phuong"}', resultPreview: '[{"id":"ven_phuong","name":"Phuong Transport","country":"VN","paypal":true,"stellar":false,"bank":"Vietcombank ****7781","verifiedAt":"2026-08-1' }, ctx);
    expect(s).toBe("Looked up Phuong Transport: known vendor, Vietcombank ****7781");
  });

  it("says when no vendor matches", () => {
    expect(toolCallSentence({ name: "lookup_vendor", input: '{"query":"Hoa Transport"}', resultPreview: "[]" }, ctx)).toBe("Looked up Hoa Transport: no vendor on file");
  });

  it("counts records from the page, not from the clipped preview", () => {
    expect(toolCallSentence({ name: "read_evidence", input: "{}", resultPreview: '{"records":[{"id":"evd_0fa8' }, ctx)).toBe("Read the attached records: 2 records");
  });

  it("names the latest earlier payment in vendor history", () => {
    const s = toolCallSentence({ name: "vendor_history", input: '{"vendorId":"ven_phuong"}', resultPreview: '[{"sourceRef":"INV-2026-0138","amountMinor":60000,"currency":"USD","settledAt":"2026-10-16T19:36:39.485Z"' }, ctx);
    expect(s).toBe("Checked Phuong Transport's payment history: earlier payments on file, including INV-2026-0138 (USD 600.00)");
  });

  it("does not claim a PayPal result it cannot see", () => {
    const s = toolCallSentence({ name: "paypal_list_transactions", input: "{}", resultPreview: '{"transaction_details":[{"transaction_info":{"transaction_id":"0BA03661BC855113S","transaction_event_code":"T1900"' }, ctx);
    expect(s).toBe("Checked PayPal transactions for INV-2026-0152: transactions read");
  });

  it("reports an empty PayPal period and a match on the reference", () => {
    expect(toolCallSentence({ name: "paypal_list_transactions", input: "{}", resultPreview: '{"transaction_details":[],"total_items":0}' }, ctx)).toBe("Checked PayPal transactions for INV-2026-0152: no transactions in the period");
    expect(toolCallSentence({ name: "paypal_list_transactions", input: "{}", resultPreview: '{"transaction_details":[{"transaction_info":{"transaction_note":"INV-2026-0152 van"' }, ctx)).toBe("Checked PayPal transactions for INV-2026-0152: a transaction mentions INV-2026-0152");
  });

  it("says no earlier payment only when the whole result is visible", () => {
    const s = toolCallSentence({ name: "paypal_list_transactions", input: "{}", resultPreview: '{"transaction_details":[{"transaction_info":{"transaction_note":"JOB-HG4D-0914 guide fee"}}],"total_items":1}' }, ctx);
    expect(s).toBe("Checked PayPal transactions: no earlier payment for INV-2026-0152 in 1 transaction");
  });

  it("reports a failed call", () => {
    expect(toolCallSentence({ name: "paypal_list_invoices", input: "{}", resultPreview: '{"error":"HTTP 401","detail":"x"}' }, ctx)).toBe("Listed PayPal invoices: the call failed (HTTP 401)");
  });
});
