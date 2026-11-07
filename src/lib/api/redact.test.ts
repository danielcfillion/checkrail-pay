import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OBLIGATION_STATES } from "../domain/types";
import { API_NEEDS_PERSON, apiReasonFor, apiReasons } from "./redact";

/**
 * What an API key reads about why a request waits is one fixed sentence per rule code, never text from
 * the books. Every code policy and the orchestrator can produce is checked here, read from their source, so a new rule
 * cannot slip through with its internal message.
 */

const source = (f: string) => fs.readFileSync(path.join(process.cwd(), "src/lib", f), "utf8");
const codes = [
  ...new Set([
    ...[...source("domain/policy.ts").matchAll(/(?:warn|block|pass|info)\("([a-z_]+)"/g)].map((m) => m[1]),
    ...[...source("engine/orchestrator.ts").matchAll(/ruleId: "([a-z_]+)"/g)].map((m) => m[1]),
    "agent_mismatch",
  ]),
];
const states = OBLIGATION_STATES.flatMap((s) => [s, s.replace(/_/g, " ")]).concat(["scheduled", "in flight"]);
const leaks = new RegExp(`\\b(?:${states.join("|")})\\b|\\d{4}-\\d{2}-\\d{2}|\\b\\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b|obl_|obligation|\\$|USD|VND|PHP|THB`, "i");

describe("reasons an API key reads", () => {
  it("cover every rule code there is", () => {
    expect(codes.length).toBeGreaterThan(25);
    expect(codes).toContain("bill_part_repeat");
    expect(codes).toContain("no_duplicate");
  });

  it("never carry another payment's state, a date, an amount, an internal id or a name, for any code", () => {
    for (const code of codes) {
      const text = apiReasonFor(code);
      expect(text, code).not.toMatch(leaks);
      expect(text, code).not.toMatch(/^A rule needs a person to look/);
    }
    expect(API_NEEDS_PERSON).not.toMatch(leaks);
  });

  it("are built from codes alone, whatever the internal message says", () => {
    const rules = [
      { ruleId: "no_duplicate", passed: false, severity: "warn", message: "Shares booking or order BK-1 with an earlier payment (obligation obl_1): USD 190.00 (settled, 2026-11-01); confirm" },
      { ruleId: "bill_part", passed: true, severity: "info", message: "Part 2 of bill INV-X; other parts: USD 190.00, approved 1 Nov" },
      { ruleId: "bill_part_repeat", passed: false, severity: "warn", message: "Bill INV-X already has another part (USD 190.00). A person confirms this is a separate payment." },
    ];
    const out = apiReasons(rules, "require_approval");
    expect(out).toEqual([apiReasonFor("no_duplicate"), apiReasonFor("bill_part_repeat")]);
    expect(out.join(" ")).not.toMatch(leaks);
    expect(apiReasons([], "require_approval")).toEqual([API_NEEDS_PERSON]);
  });
});
