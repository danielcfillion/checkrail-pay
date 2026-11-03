import { describe, expect, it } from "vitest";
import { toXeroBill, toXeroFeeTransaction, toXeroPayment } from "./xero";
import type { AccountingPayload } from "./record";

const payload = (over: Partial<AccountingPayload>): AccountingPayload => ({
  reference: "JOB-1", vendorName: "V", vendorCountry: "PH", description: "d", billDate: "2026-10-01", paymentDate: "2026-10-02",
  grossAmount: "180.00", grossCurrency: "USD", feeAmount: "3.60", feeCurrency: "USD", netPaid: "183.60", recipientReceived: null, recipientCurrency: null,
  fxRate: null, rail: "paypal", externalTransactionId: "X", explorerUrl: null, accountCode: "310 x", obligationId: "o", ...over,
});

describe("Xero mapping reconciles to the cent", () => {
  it("PayPal: bill + payment of the gross, plus a separate fee spend; cash out equals netPaid", () => {
    const r = payload({});
    const out = Number(toXeroPayment(r, "090").Amount) + Number(toXeroFeeTransaction(r, "090")!.LineItems[0].UnitAmount);
    expect(out).toBeCloseTo(Number(r.netPaid), 2);
    expect(toXeroBill(r).LineItems[0].UnitAmount).toBe(180);
  });
  it("Stellar: the business pays the fee on top, like PayPal, so a fee spend is booked; payment plus fee equals netPaid", () => {
    const r = payload({ rail: "stellar", grossAmount: "750.00", feeAmount: "13.41", netPaid: "763.41", feePaidBy: "business" });
    const fee = toXeroFeeTransaction(r, "091")!;
    expect(fee).toMatchObject({ Type: "SPEND", BankAccount: { Code: "091" }, Contact: { Name: "Stellar anchor fee" } });
    expect(Number(toXeroPayment(r, "091").Amount) + fee.LineItems[0].UnitAmount).toBeCloseTo(Number(r.netPaid), 2);
  });
  it("a Stellar record from before 3 Nov 2026, where the fee came out of the amount, books no fee spend", () => {
    const r = payload({ rail: "stellar", grossAmount: "750.00", feeAmount: "13.25", netPaid: "750.00" });
    expect(toXeroFeeTransaction(r, "091")).toBeNull();
    expect(Number(toXeroPayment(r, "091").Amount)).toBeCloseTo(Number(r.netPaid), 2);
  });
});
