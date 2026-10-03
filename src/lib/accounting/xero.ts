import type { AccountingPayload } from "./record";

/**
 * Xero adapter: the interface Dueline writes to, with the OAuth path stubbed.
 *
 * Human Gate: a Xero developer app and OAuth consent are required before
 * `XeroAdapter.push` can run against a real tenant. Until then the mapping
 * below is exercised by tests and the CSV exporter, which produces the same
 * fields in the same order, so the switch is a configuration change.
 *
 * Mapping (Xero Accounting API):
 *   Contact            <- vendorName (+ country on the address)
 *   Invoice (ACCPAY)   <- reference, billDate, description, grossAmount/grossCurrency, accountCode
 *   Payment            <- paymentDate, netPaid, bank account for the rail (PayPal clearing / Stellar treasury)
 *   Bank fee line      <- feeAmount on a "Bank fees" account, so gross, fee and net reconcile
 */
export interface AccountingAdapter {
  readonly destination: "xero" | "quickbooks" | "csv";
  push(record: AccountingPayload): Promise<{ externalRef: string }>;
}

export function toXeroBill(r: AccountingPayload) {
  return {
    Type: "ACCPAY",
    Contact: { Name: r.vendorName },
    Date: r.billDate,
    DueDate: r.billDate,
    InvoiceNumber: r.reference,
    Reference: r.obligationId,
    CurrencyCode: r.grossCurrency,
    Status: "AUTHORISED",
    LineItems: [
      { Description: r.description || r.reference, Quantity: 1, UnitAmount: Number(r.grossAmount), AccountCode: r.accountCode.split(" ")[0] },
    ],
  };
}

export function toXeroPayment(r: AccountingPayload, bankAccountCode: string) {
  return {
    Invoice: { InvoiceNumber: r.reference },
    Account: { Code: bankAccountCode },
    Date: r.paymentDate,
    Amount: Number(r.grossAmount),
    Reference: `${r.rail}:${r.externalTransactionId}`,
  };
}

export function toXeroFeeTransaction(r: AccountingPayload, bankAccountCode: string) {
  if (Number(r.feeAmount) === 0) return null;
  return {
    Type: "SPEND",
    Contact: { Name: r.rail === "paypal" ? "PayPal" : "Stellar network / anchor" },
    Date: r.paymentDate,
    BankAccount: { Code: bankAccountCode },
    Reference: `fee ${r.reference}`,
    LineItems: [{ Description: `Payment fee for ${r.reference}`, UnitAmount: Number(r.feeAmount), AccountCode: "404" }],
  };
}

export class XeroAdapter implements AccountingAdapter {
  readonly destination = "xero" as const;
  constructor(private readonly tenant: { accessToken: string; tenantId: string; paypalClearingCode: string; stellarTreasuryCode: string }) {}

  async push(r: AccountingPayload): Promise<{ externalRef: string }> {
    const bank = r.rail === "paypal" ? this.tenant.paypalClearingCode : this.tenant.stellarTreasuryCode;
    const headers = { Authorization: `Bearer ${this.tenant.accessToken}`, "xero-tenant-id": this.tenant.tenantId, "Content-Type": "application/json", Accept: "application/json" };
    const base = "https://api.xero.com/api.xro/2.0";
    const bill = await fetch(`${base}/Invoices`, { method: "POST", headers, body: JSON.stringify({ Invoices: [toXeroBill(r)] }) });
    if (!bill.ok) throw new Error(`Xero bill failed: HTTP ${bill.status}`);
    const billJson = (await bill.json()) as { Invoices: Array<{ InvoiceID: string }> };
    const pay = await fetch(`${base}/Payments`, { method: "PUT", headers, body: JSON.stringify({ Payments: [toXeroPayment(r, bank)] }) });
    if (!pay.ok) throw new Error(`Xero payment failed: HTTP ${pay.status}`);
    const fee = toXeroFeeTransaction(r, bank);
    if (fee) {
      const f = await fetch(`${base}/BankTransactions`, { method: "PUT", headers, body: JSON.stringify({ BankTransactions: [fee] }) });
      if (!f.ok) throw new Error(`Xero fee transaction failed: HTTP ${f.status}`);
    }
    return { externalRef: billJson.Invoices[0]?.InvoiceID ?? r.reference };
  }
}
