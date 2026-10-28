import { describe, expect, it } from "vitest";
import { routerNote } from "./route-note";

describe("routerNote", () => {
  it("drops the list of unavailable rails the cards already explain", () => {
    expect(routerNote("PayPal is the only supported route (Stellar: No licensed VND off-ramp; Vietnam Law 71/2025 does not recognise crypto as a means of payment; Wise: Phuong Transport has no full bank account number on file; Bank file: The bank file pays VND only).")).toBe("PayPal is the only supported route.");
  });
  it("leaves a plain reason alone", () => {
    const r = "Effectively equal cost across Stellar and PayPal (PHP 59.54 per USD spent). PayPal wins the tie because more of its path runs end to end; Stellar is faster.";
    expect(routerNote(r)).toBe(r);
    expect(routerNote("Stellar is Ana Reyes's stated preference.")).toBe("Stellar is Ana Reyes's stated preference.");
  });
});
