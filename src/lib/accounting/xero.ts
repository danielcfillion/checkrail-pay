import type { AccountingPayload } from "./record";
import { feePaidByOf } from "./billLine";

/**
 * Xero mapping and the adapter Checkrail Pay writes through.
 *
 * The live connection (OAuth, token storage, the account mapping and the push itself) is in xeroAuth.ts,
 * xeroClient.ts and xeroSync.ts; see docs/XERO.md. Without a connection the bills file and the settlement CSV carry
 * the same fields in the same order, so the books look the same whichever path a record took.
 *
 * Mapping (Xero Accounting API):
 *   Contact            <- vendorName (+ country on the address)
 *   Invoice (ACCPAY)   <- reference, billDate, description, grossAmount/grossCurrency, accountCode
 *   Payment            <- paymentDate, the amount sent (gross less any tax withheld), bank account for the rail
 *   Bank fee line      <- feeAmount on the fee account, so gross, fee and net reconcile (netPaid is what left the account on every rail)
 */
export interface AccountingAdapter {
  readonly destination: "xero" | "quickbooks" | "csv";
  push(record: AccountingPayload): Promise<{ externalRef: string }>;
}

/** Minor units (hundredths) of a decimal string, so amounts are added and subtracted without float drift. */
const hundredths = (v: string | undefined | null) => Math.round(Number(v || 0) * 100);

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
    // What was sent: the bill less any tax kept back for the tax office (that part is not paid to the vendor).
    Amount: (hundredths(r.grossAmount) - hundredths(r.withheldAmount)) / 100,
    Reference: `${r.rail}:${r.externalTransactionId}`,
  };
}

export function xeroFeeReference(r: Pick<AccountingPayload, "reference" | "obligationId">): string {
  return `fee ${r.reference} ${r.obligationId}`;
}

/**
 * A separate fee spend whenever there is a fee: the business pays it on top of the bill on every rail (Stellar grosses
 * up what it sends so the vendor still receives the full amount), so the payment plus the fee equals netPaid.
 */
export function toXeroFeeTransaction(r: AccountingPayload, bankAccountCode: string, feeAccountCode = "404") {
  if (Number(r.feeAmount) === 0 || feePaidByOf(r) === "recipient") return null; // an old Stellar record: the recipient bore it
  return {
    Type: "SPEND",
    Contact: { Name: r.rail === "paypal" ? "PayPal" : r.rail === "wise" ? "Wise" : r.rail === "stellar" ? "Stellar anchor fee" : "Bank transfer fee" },
    Date: r.paymentDate,
    BankAccount: { Code: bankAccountCode },
    // One per payment: a deposit and its balance share the bill's reference, so the payment's own id goes on too.
    Reference: xeroFeeReference(r),
    LineItems: [{ Description: `Payment fee for ${r.reference}`, Quantity: 1, UnitAmount: Number(r.feeAmount), AccountCode: feeAccountCode }],
  };
}
