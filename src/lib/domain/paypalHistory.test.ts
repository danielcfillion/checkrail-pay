import { describe, it, expect } from "vitest";
import { matchPayPalHistory } from "./paypalHistory";
import { jobKeys } from "./ids";

const line = (id: string, value: string, note: string, email: string, status = "S", ref?: string) => ({ transaction_info: { transaction_id: id, transaction_amount: { currency_code: "USD", value }, transaction_note: note, transaction_initiation_date: "2026-10-12T03:12:44Z", transaction_status: status, paypal_reference_id: ref }, payer_info: { email_address: email } });
const body = (...rows: unknown[]) => JSON.stringify({ transaction_details: rows });
const ids = jobKeys("JOB-HG4D-0914");

describe("PayPal's own history", () => {
  it("finds money already sent to this payee for this job", () => {
    const r = matchPayPalHistory(body(line("7XJ", "-180.00", "JOB-HG4D-0914 guide fee", "Maria@Example.com")), ids, "maria@example.com");
    expect(r.matches).toEqual([{ transactionId: "7XJ", date: "2026-10-12", amountMinor: 18_000, currency: "USD", email: "maria@example.com", matched: "JOB-HG4D-0914" }]);
  });

  it("finds it under the trip sheet's form of the same job", () => {
    expect(matchPayPalHistory(body(line("7XJ", "-180.00", "Trip HG-4D-0914", "m@x.co")), ids, "m@x.co").matches).toHaveLength(1);
  });

  it("ignores another payee, money in, failed lines, other jobs and longer numbers", () => {
    const r = matchPayPalHistory(
      body(line("A", "-180.00", "JOB-HG4D-0914", "someone@else.co"), line("B", "180.00", "JOB-HG4D-0914", "m@x.co"), line("C", "-180.00", "JOB-HG4D-0914", "m@x.co", "D"), line("D", "-180.00", "JOB-HG4D-0915", "m@x.co"), line("E", "-180.00", "JOB-HG4D-09145", "m@x.co")),
      ids,
      "m@x.co",
    );
    expect(r.matches).toEqual([]);
    expect(r.lines).toBe(5);
  });

  it("does not count a payout PayPal reversed, or one recorded here as come back", () => {
    expect(matchPayPalHistory(body(line("P1", "-180.00", "JOB-HG4D-0914", "m@x.co"), line("R1", "180.00", "returned", "m@x.co", "S", "P1")), ids, "m@x.co").matches).toEqual([]);
    expect(matchPayPalHistory(body(line("P1", "-180.00", "JOB-HG4D-0914", "m@x.co")), ids, "m@x.co", ["P1"]).matches).toEqual([]);
  });

  it("is safe with nothing to go on", () => {
    expect(matchPayPalHistory("not json", ids, "m@x.co").matches).toEqual([]);
    expect(matchPayPalHistory(body(line("P1", "-1.00", "JOB-HG4D-0914", "m@x.co")), [], "m@x.co").matches).toEqual([]);
    expect(matchPayPalHistory(body(line("P1", "-1.00", "JOB-HG4D-0914", "m@x.co")), ids, null).matches).toEqual([]);
  });
});
