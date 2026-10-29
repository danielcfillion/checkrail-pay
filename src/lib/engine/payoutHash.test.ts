import { afterEach, describe, expect, it } from "vitest";
import { encryptField } from "../crypto/dataKey";
import { hashPayoutDetails } from "../domain/ids";
import { payoutHashOf } from "./orchestrator";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const saved = process.env.CHECKRAIL_DATA_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.CHECKRAIL_DATA_KEY;
  else process.env.CHECKRAIL_DATA_KEY = saved;
});

const ACCOUNT = "100000122345";
const vendor = { paypalEmail: null, stellarAccount: null, bankLabel: "VCB ****2345", bankCode: "VCB", bankAccountNumber: ACCOUNT };

/** The reviewer's recipe: the label shows the last four digits, so only the middle digits are unknown. */
function searchMiddle(target: string): number | null {
  for (let n = 0; n < 20_000; n++) {
    const candidate = `10${String(n).padStart(6, "0")}2345`;
    if (hashPayoutDetails([null, null, vendor.bankLabel, `VCB:${candidate}`]) === target) return n;
  }
  return null;
}

describe("payout hash (SEC5-2)", () => {
  it("does not let someone with only the database find the account number", () => {
    process.env.CHECKRAIL_DATA_KEY = KEY_A;
    const stored = payoutHashOf(vendor);
    // Control: the old, unsalted construction falls to this search at once.
    expect(searchMiddle(hashPayoutDetails([null, null, vendor.bankLabel, `VCB:${ACCOUNT}`]))).toBe(12);
    // The stored hash does not.
    expect(searchMiddle(stored)).toBeNull();
  });

  it("is stable for one data key and changes with another", () => {
    process.env.CHECKRAIL_DATA_KEY = KEY_A;
    expect(payoutHashOf(vendor)).toBe(payoutHashOf({ ...vendor }));
    const a = payoutHashOf(vendor);
    process.env.CHECKRAIL_DATA_KEY = KEY_B;
    expect(payoutHashOf(vendor)).not.toBe(a);
  });

  it("is the same whether the number arrives in plain or encrypted, and still notices a changed number", () => {
    process.env.CHECKRAIL_DATA_KEY = KEY_A;
    const { bankAccountNumber: _n, ...rest } = vendor;
    void _n;
    expect(payoutHashOf({ ...rest, bankAccountEnc: encryptField(ACCOUNT) })).toBe(payoutHashOf(vendor));
    expect(payoutHashOf({ ...vendor, bankAccountNumber: "100000122346" })).not.toBe(payoutHashOf(vendor));
  });

  it("leaves details with no bank account hashed exactly as before", () => {
    expect(payoutHashOf({ paypalEmail: "a@b.example", stellarAccount: null, bankLabel: null })).toBe(hashPayoutDetails(["a@b.example", null, null]));
  });
});
