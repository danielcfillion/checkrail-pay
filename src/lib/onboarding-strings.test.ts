import { describe, expect, it } from "vitest";
import { validatePayout, validateProfile, lookupInvite } from "@/lib/engine/vendors";
import { bankOptionLabel, classifyOnboardingError, formatExpiryVi, linkReasonCode, precheckOnboarding, resolveLang, STRINGS, type ErrorCode } from "./onboarding-strings";

/** Every leaf of a dictionary as a dotted path, with functions as "fn". */
function leaves(o: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) Object.assign(out, leaves(v, path));
    else out[path] = typeof v === "function" ? "fn" : "str";
  }
  return out;
}

/** The text of every string, calling functions with sample arguments. */
function texts(o: unknown, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([path, v]);
    else if (typeof v === "function") out.push([path, (v as (...a: unknown[]) => string)("Acme", 2)], [`${path} (empty)`, (v as (...a: unknown[]) => string)("", 1)]);
    else if (typeof v === "object" && v !== null) out.push(...texts(v, path));
  }
  return out;
}

describe("onboarding strings", () => {
  it("has a Vietnamese string for every English one, of the same kind, and nothing extra", () => {
    expect(leaves(STRINGS.vi)).toEqual(leaves(STRINGS.en));
  });

  it("has a Vietnamese message for every error code", () => {
    const codes = Object.keys(STRINGS.en.errors) as ErrorCode[];
    expect(codes.length).toBeGreaterThan(15);
    for (const c of codes) {
      expect(STRINGS.vi.errors[c], c).toBeTruthy();
      expect(STRINGS.vi.errors[c], c).not.toBe(STRINGS.en.errors[c]);
    }
  });

  it("writes Vietnamese in Vietnamese: diacritics, not English left behind", () => {
    // "English" is the Vietnamese page's switch back to English, and a few names are the same in both.
    const sameInBoth = new Set(["switchTo", "paypalEmail", "homestay", "countries.CA", "countries.PH", "roles.homestay", "example (empty)", "heading (empty)"]);
    const vi = Object.fromEntries(texts(STRINGS.vi));
    const en = Object.fromEntries(texts(STRINGS.en));
    for (const [path, text] of Object.entries(vi)) {
      if (sameInBoth.has(path)) continue;
      expect(text, path).toMatch(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i);
      expect(text, path).not.toBe(en[path]);
    }
  });

  it("has no em dashes and no empty strings in either language", () => {
    for (const lang of ["en", "vi"] as const) {
      for (const [path, text] of texts(STRINGS[lang])) {
        expect(text.trim(), `${lang} ${path}`).not.toBe("");
        expect(text, `${lang} ${path}`).not.toContain("\u2014");
      }
    }
  });
});

describe("classifyOnboardingError", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return classifyOnboardingError((e as Error).message);
    }
    throw new Error("expected the validator to throw");
  };

  it("recognises what the real validators throw, with the field it belongs to", () => {
    expect(code(() => validatePayout({}))).toEqual({ code: "noWayToPay", field: "v-pp" });
    expect(code(() => validatePayout({ paypalEmail: "nope" }))).toEqual({ code: "paypalInvalid", field: "v-pp" });
    expect(code(() => validatePayout({ bankAccountNumber: "123" }))).toEqual({ code: "accountNumberInvalid", field: "v-acct" });
    expect(code(() => validatePayout({ stellarAccount: "GABC" }))).toEqual({ code: "stellarInvalid", field: "v-xlm" });
    expect(code(() => validatePayout({ paypalEmail: "a@b.co", preferredRail: "stellar" }))).toEqual({ code: "railNeedsStellar", field: "v-rail" });
    expect(code(() => validatePayout({ paypalEmail: "a@b.co", bankCode: "!!" }))).toEqual({ code: "bankCodeInvalid", field: "v-bcode" });
    expect(code(() => validatePayout({ paypalEmail: "a@b.co", bankCurrency: "dong" }))).toEqual({ code: "tooLong", field: "v-bcur" });
    expect(code(() => validateProfile({ name: "", role: "guide", country: "VN" }))).toEqual({ code: "nameRequired", field: "v-name" });
    expect(code(() => validateProfile({ name: "Linh", role: "guide", country: "VN", email: "x" }))).toEqual({ code: "emailInvalid", field: "v-email" });
    expect(code(() => validateProfile({ name: "Linh", role: "guide", country: "VN", phone: "abc" }))).toEqual({ code: "phoneInvalid", field: "v-phone" });
    expect(code(() => validateProfile({ name: "L".repeat(81), role: "guide", country: "VN" }))).toEqual({ code: "tooLong", field: "v-name" });
  });

  it("recognises the link messages", () => {
    const invalid = lookupInvite(null as never, "short");
    expect(invalid.ok).toBe(false);
    expect(classifyOnboardingError(invalid.ok ? "" : invalid.reason).code).toBe("linkInvalid");
    expect(linkReasonCode("This link has already been used. Ask for a new one if you need to change your details again.")).toBe("linkUsed");
    expect(linkReasonCode("This link has expired. Ask for a new one.")).toBe("linkExpired");
    expect(linkReasonCode("anything else")).toBe("linkInvalid");
    expect(classifyOnboardingError("Open your link to submit.").code).toBe("openYourLink");
  });

  it("never lets an unknown English message through", () => {
    expect(classifyOnboardingError("SQLITE_BUSY: database is locked")).toEqual({ code: "generic", field: null });
  });
});

describe("helpers", () => {
  it("picks the language: the link's ask, then the vendor's country", () => {
    expect(resolveLang("en", "VN")).toBe("en");
    expect(resolveLang("vi", "PH")).toBe("vi");
    expect(resolveLang(undefined, "VN")).toBe("vi");
    expect(resolveLang("fr", "PH")).toBe("en");
    expect(resolveLang(undefined, null)).toBe("en");
  });

  it("writes the expiry with the month in words, in Vietnam's date", () => {
    expect(formatExpiryVi("2026-11-06T03:00:00.000Z")).toBe("6 tháng 11 năm 2026");
    expect(formatExpiryVi("2026-11-05T18:00:00.000Z")).toBe("6 tháng 11 năm 2026");
    expect(formatExpiryVi("2026-12-31T20:00:00.000Z")).toBe("1 tháng 1 năm 2027");
  });

  it("does not print a bank's code twice", () => {
    expect(bankOptionLabel("BIDV", "BIDV")).toBe("BIDV");
    expect(bankOptionLabel("VCB", "Vietcombank")).toBe("Vietcombank (VCB)");
  });

  it("lists both plain problems in one pass", () => {
    const none = { name: " ", paypalEmail: "", stellarAccount: "", bankAccountNumber: "" };
    expect(precheckOnboarding(none, true)).toEqual([{ code: "nameRequired", field: "v-name" }, { code: "noWayToPay", field: "v-pp" }]);
    expect(precheckOnboarding(none, false)).toEqual([{ code: "noWayToPay", field: "v-pp" }]);
    expect(precheckOnboarding({ ...none, name: "Linh", bankAccountNumber: "0071000123456" }, true)).toEqual([]);
  });
});
