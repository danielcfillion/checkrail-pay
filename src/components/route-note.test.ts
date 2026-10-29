import { describe, expect, it } from "vitest";
import { lowerFirst, routeLine, routerNote } from "./route-note";
import { railLabel } from "@/lib/format";

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

describe("routeLine", () => {
  const tie = "Effectively equal cost across Stellar and PayPal (PHP 59.54 per USD spent). PayPal wins the tie because more of its path runs end to end; Stellar is faster.";
  it("leads with ready to pay and keeps the tie-break arithmetic on the cards", () => {
    expect(routeLine(tie, "paypal", true, railLabel)).toBe("Ready to pay over PayPal. It costs the same as Stellar here and runs more of the way end to end; Stellar is faster.");
    expect(routeLine(tie, "paypal", true, railLabel)).not.toMatch(/per USD spent|wins the tie/);
  });
  it("says which rail is chosen before it is ready", () => {
    expect(routeLine(tie, "paypal", false, railLabel)).toBe("PayPal is chosen. It costs the same as Stellar here and runs more of the way end to end; Stellar is faster.");
    expect(routeLine("Stellar is Ana Reyes's stated preference.", "stellar", false, railLabel)).toBe("Stellar is Ana Reyes's stated preference.");
    expect(routeLine("PayPal is the only supported route (Stellar: none).", "paypal", true, railLabel)).toBe("Ready to pay over PayPal. PayPal is the only supported route.");
  });
});

describe("lowerFirst", () => {
  it("keeps a vendor name capitalised", () => {
    expect(lowerFirst("Maria Santos has no full bank account number on file")).toBe("Maria Santos has no full bank account number on file");
    expect(lowerFirst("No licensed VND off-ramp")).toBe("no licensed VND off-ramp");
    expect(lowerFirst("The bank file pays VND only")).toBe("the bank file pays VND only");
  });
});
