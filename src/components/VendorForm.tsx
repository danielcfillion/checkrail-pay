"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createVendorAction, proposePayoutAction, updateVendorAction } from "@/app/actions";
import { submitOnboardingAction } from "@/app/onboard/actions";
import { bankOptionLabel, precheckOnboarding, STRINGS, type OnboardingError } from "@/lib/onboarding-strings";
import { useToast } from "./Toast";

export type VendorFormValues = {
  name: string;
  role: string;
  country: string;
  email: string;
  notes: string;
  defaultAccountCode: string;
  preferredRail: string;
  paypalEmail: string;
  stellarAccount: string;
  bankCountry: string;
  bankCurrency: string;
  bankLabel: string;
  bankAccountNumber: string;
  bankCode: string;
  accountHolder: string;
  taxType?: string;
  taxForm?: string;
  withholdingPct?: string;
  phone?: string;
  taxId?: string;
  paymentTermsDays?: string;
  retainer?: string;
};

export const EMPTY_VENDOR: VendorFormValues = { name: "", role: "guide", country: "VN", email: "", notes: "", defaultAccountCode: "", preferredRail: "", paypalEmail: "", stellarAccount: "", bankCountry: "", bankCurrency: "", bankLabel: "", bankAccountNumber: "", bankCode: "", accountHolder: "" };

const ROLES = ["guide", "driver", "homestay", "hotel", "creator", "supplier", "contractor"];
const COUNTRIES = ["VN", "PH", "TH", "US", "CA", "GB"];

type Mode = "create" | "profile" | "payout" | "onboard-new" | "onboard-existing";

/** Common Vietnamese banks by the short code bank files use. */
const VN_BANKS: Array<[string, string]> = [
  ["VCB", "Vietcombank"],
  ["BIDV", "BIDV"],
  ["CTG", "VietinBank"],
  ["AGR", "Agribank"],
  ["TCB", "Techcombank"],
  ["MB", "MB Bank"],
  ["ACB", "ACB"],
  ["VPB", "VPBank"],
  ["TPB", "TPBank"],
  ["STB", "Sacombank"],
  ["SHB", "SHB"],
  ["VIB", "VIB"],
];

/**
 * One form for the vendor master: add a vendor, edit their profile, request new payout details, or (on the public
 * onboarding page) let the vendor enter their own. Payout fields are never saved straight onto the vendor.
 */
export function VendorForm({ mode, initial: given = EMPTY_VENDOR, vendorId, token, hasAccount = false, lang = "en", defaultCountry, business, intro }: { mode: Mode; initial?: VendorFormValues; vendorId?: string; token?: string; hasAccount?: boolean; lang?: "en" | "vi"; defaultCountry?: string; business?: string; intro?: ReactNode }) {
  const initial = defaultCountry ? { ...given, country: defaultCountry } : given;
  // Internal screens are English; only a vendor's own link is translated.
  const onboarding = mode === "onboard-new" || mode === "onboard-existing";
  const t = STRINGS[onboarding ? lang : "en"];
  const [v, setV] = useState<VendorFormValues>(initial);
  const [problems, setProblems] = useState<OnboardingError[]>([]);
  const summary = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState("");
  const [dropAccount, setDropAccount] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const set = (k: keyof VendorFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const showProfile = mode === "create" || mode === "profile" || mode === "onboard-new";
  const showPayout = mode !== "profile";
  const internal = mode === "create" || mode === "profile";

  const profile = { name: v.name, role: v.role, country: v.country, email: v.email || null, notes: v.notes || null, defaultAccountCode: v.defaultAccountCode || null, phone: v.phone || null, taxId: v.taxId || null, ...(internal ? { paymentTermsDays: v.paymentTermsDays ? Number(v.paymentTermsDays) : null, retainerMinor: v.retainer ? Math.round(Number(v.retainer.replace(/,/g, "")) * 100) : null } : {}), ...(internal ? { taxType: v.taxType || null, taxForm: v.taxForm || null, withholdingBps: v.withholdingPct ? Math.round(Number(v.withholdingPct) * 100) : null } : { taxType: v.taxType || null }) };
  const payout = { preferredRail: v.preferredRail || null, paypalEmail: v.paypalEmail || null, stellarAccount: v.stellarAccount || null, bankCountry: v.bankCountry || null, bankCurrency: v.bankCurrency || null, bankLabel: v.bankLabel || null, bankAccountNumber: v.bankAccountNumber || null, bankCode: v.bankCode || null, accountHolder: v.accountHolder || null };

  const submit = () =>
    start(async () => {
      if (mode === "create") {
        const r = await createVendorAction(profile, payout);
        toast(r.message, r.ok ? "ok" : "error");
        if (r.ok && r.id) router.push(`/vendors/${r.id}`);
      } else if (mode === "profile") {
        const r = await updateVendorAction(vendorId!, profile);
        toast(r.message, r.ok ? "ok" : "error");
        if (r.ok) router.push(`/vendors/${vendorId}`);
      } else if (mode === "payout") {
        const r = await proposePayoutAction(vendorId!, { ...payout, keepBankAccount: !dropAccount }, note || undefined);
        toast(r.message, r.ok ? "ok" : "error");
        if (r.ok) router.push(`/vendors/${vendorId}`);
      } else {
        // Say everything that is plainly missing in one pass; the server still checks whatever gets through.
        const early = precheckOnboarding({ name: v.name, paypalEmail: v.paypalEmail, stellarAccount: v.stellarAccount, bankAccountNumber: v.bankAccountNumber }, mode === "onboard-new");
        if (early.length) {
          setProblems(early);
          return;
        }
        const r = await submitOnboardingAction(token!, { profile: mode === "onboard-new" ? profile : undefined, payout });
        if (r.ok) {
          setProblems([]);
          setDone(r.message);
        } else setProblems([r.error ?? { code: "generic", field: null }]);
      }
    });

  // The summary takes focus when it appears, so a screen reader announces it and a keyboard user starts at the fix.
  useEffect(() => {
    if (problems.length) summary.current?.focus();
  }, [problems]);

  if (done) {
    return (
      <div className="panel p-5" role="status">
        <div className="flex items-start gap-3">
          <svg width="22" height="22" viewBox="0 0 18 18" fill="none" stroke="var(--settled)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0">
            <circle cx="9" cy="9" r="7.25" />
            <path d="M5.75 9.25l2.25 2.25 4.25-4.75" />
          </svg>
          <div>
            <h2 className="text-lg font-semibold leading-6">{t.sentTitle}</h2>
            <p className="mt-1">{t.sentBody}</p>
            <p className="mt-2 text-ink-soft">
              {t.sentTo(business ?? "")} {t.canClose}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const errorFor = (field: string) => {
    const p = problems.find((x) => x.field === field);
    return p ? t.errors[p.code] : undefined;
  };

  return (
    <>
      {intro}
      <form
        className="space-y-6"
        noValidate={onboarding}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {showProfile ? (
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-medium">{internal ? "Who they are" : t.aboutYou}</legend>
            <Field label={internal ? "Name" : t.nameLabel} id="v-name" required={!internal ? t.required : undefined} error={errorFor("v-name")}>
              <input id="v-name" className="field" value={v.name} onChange={set("name")} required maxLength={80} autoComplete="organization" {...fieldA11y("v-name", errorFor("v-name"), !internal)} />
            </Field>
            <Field label={t.whatYouDo} id="v-role">
              <select id="v-role" className="field" value={v.role} onChange={set("role")}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t.roles[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.country} id="v-country">
              <select id="v-country" className="field" value={v.country} onChange={set("country")}>
                {COUNTRIES.map((c) => (
                  <option key={c} value={c}>
                    {t.countries[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={internal ? "Email" : t.contactEmail} id="v-email" hint={internal ? undefined : t.contactEmailHint} error={errorFor("v-email")}>
              <input id="v-email" type="email" className="field" value={v.email} onChange={set("email")} maxLength={254} autoComplete="email" {...fieldA11y("v-email", errorFor("v-email"), false, !internal)} />
            </Field>
            <Field label={internal ? "Phone, with country code (used to call back about bank changes)" : t.phone} id="v-phone" error={errorFor("v-phone")}>
              <input id="v-phone" type="tel" className="field num" value={v.phone ?? ""} onChange={set("phone")} maxLength={24} autoComplete="tel" placeholder="+84 912 345 678" {...fieldA11y("v-phone", errorFor("v-phone"))} />
            </Field>
            <Field label={v.country === "VN" ? t.taxIdVn : t.taxIdOther} id="v-taxid" error={errorFor("v-taxid")}>
              <input id="v-taxid" className="field num" value={v.taxId ?? ""} onChange={set("taxId")} maxLength={20} autoComplete="off" {...fieldA11y("v-taxid", errorFor("v-taxid"))} />
            </Field>
            {!internal ? (
              <Field label={t.paidAs} id="v-taxtype2">
                <select id="v-taxtype2" className="field" value={v.taxType ?? ""} onChange={set("taxType")}>
                  <option value="">{t.choose}</option>
                  <option value="individual">{t.individual}</option>
                  <option value="business">{t.business}</option>
                </select>
              </Field>
            ) : null}
            {internal ? (
              <>
                <Field label="Account code for the books (optional)" id="v-code">
                  <input id="v-code" className="field num" value={v.defaultAccountCode} onChange={set("defaultAccountCode")} maxLength={20} placeholder="5100" />
                </Field>
                <Field label="Payment terms when the invoice gives none, days (optional)" id="v-terms">
                  <input id="v-terms" className="field num" inputMode="numeric" value={v.paymentTermsDays ?? ""} onChange={set("paymentTermsDays")} placeholder="14" />
                </Field>
                <Field label="Monthly retainer, in their invoice currency (optional)" id="v-retainer">
                  <input id="v-retainer" className="field num" inputMode="decimal" value={v.retainer ?? ""} onChange={set("retainer")} placeholder="450" />
                </Field>
                <Field label="Notes (optional)" id="v-notes">
                  <input id="v-notes" className="field" value={v.notes} onChange={set("notes")} maxLength={500} />
                </Field>
                <Field label="Paid as" id="v-taxtype">
                  <select id="v-taxtype" className="field" value={v.taxType ?? ""} onChange={set("taxType")}>
                    <option value="">Not recorded</option>
                    <option value="individual">{t.individual}</option>
                    <option value="business">{t.business}</option>
                  </select>
                </Field>
                <Field label="Tax form on file" id="v-taxform">
                  <select id="v-taxform" className="field" value={v.taxForm ?? ""} onChange={set("taxForm")}>
                    <option value="">None yet</option>
                    <option value="w9">W-9 (US person)</option>
                    <option value="w8ben">W-8BEN (foreign individual)</option>
                    <option value="w8bene">W-8BEN-E (foreign entity)</option>
                    <option value="vn_08">Commitment 08/CK-TNCN (Vietnam)</option>
                  </select>
                </Field>
                <Field label="Philippine EWT rate, % (optional)" id="v-ewt">
                  <input id="v-ewt" className="field num" inputMode="decimal" value={v.withholdingPct ?? ""} onChange={set("withholdingPct")} placeholder="2" />
                </Field>
              </>
            ) : null}
          </fieldset>
        ) : null}

        {showPayout ? (
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-medium">{internal || mode === "payout" ? "Where payments go" : t.wherePaid}</legend>
            <p className="text-sm text-ink-soft sm:col-span-2">
              {mode === "payout"
                ? "These replace the details on file once someone else confirms them with the vendor on a number or address you already have. Until then, payments keep going to the current details."
                : internal
                  ? "Give at least one. The vendor cannot be paid until someone other than you has confirmed these with them."
                  : t.giveOne}
            </p>
            <Field label={t.paypalEmail} id="v-pp" hint={internal || mode === "payout" ? undefined : t.paypalEmailHint} error={errorFor("v-pp")}>
              <input id="v-pp" type="email" className="field" value={v.paypalEmail} onChange={set("paypalEmail")} maxLength={254} {...fieldA11y("v-pp", errorFor("v-pp"), false, !internal && mode !== "payout")} />
            </Field>
            {internal || mode === "payout" || v.country === "PH" || v.stellarAccount ? (
              <Field label={t.stellar} id="v-xlm" error={errorFor("v-xlm")}>
                <input id="v-xlm" className="field num" value={v.stellarAccount} onChange={set("stellarAccount")} maxLength={56} placeholder="G..." spellCheck={false} {...fieldA11y("v-xlm", errorFor("v-xlm"))} />
              </Field>
            ) : null}
            <Field label={t.accountNumber} id="v-acct" error={errorFor("v-acct")}>
              <input id="v-acct" className="field num" value={v.bankAccountNumber} onChange={set("bankAccountNumber")} maxLength={34} inputMode="numeric" autoComplete="off" placeholder={initial.bankLabel ? `on file: ${initial.bankLabel}` : "0071000123456"} {...fieldA11y("v-acct", errorFor("v-acct"))} />
            </Field>
            {(v.bankCountry || v.country) === "VN" ? (
              <Field label={t.bank} id="v-bcode" error={errorFor("v-bcode")}>
                <select id="v-bcode" className="field" value={v.bankCode} onChange={(e) => setV({ ...v, bankCode: e.target.value, bankCountry: v.bankCountry || "VN", bankCurrency: v.bankCurrency || "VND" })} {...fieldA11y("v-bcode", errorFor("v-bcode"))}>
                  <option value="">{t.choose}</option>
                  {VN_BANKS.map(([code, name]) => (
                    <option key={code} value={code}>
                      {bankOptionLabel(code, name)}
                    </option>
                  ))}
                  {v.bankCode && !VN_BANKS.some(([c]) => c === v.bankCode) ? <option value={v.bankCode}>{v.bankCode}</option> : null}
                </select>
              </Field>
            ) : (
              <Field label={t.bankCode} id="v-bcode" error={errorFor("v-bcode")}>
                <input id="v-bcode" className="field num" value={v.bankCode} onChange={set("bankCode")} maxLength={11} placeholder="BDO, BPI, KBANK" {...fieldA11y("v-bcode", errorFor("v-bcode"))} />
              </Field>
            )}
            <Field label={t.accountHolder} id="v-holder" error={errorFor("v-holder")}>
              <input id="v-holder" className="field" value={v.accountHolder} onChange={set("accountHolder")} maxLength={70} placeholder="NGUYEN THI LINH" {...fieldA11y("v-holder", errorFor("v-holder"))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              {/* The sample reads "e.g. VN" so it is not mistaken for a value that is already filled in. Picking a Vietnamese bank fills both. */}
              <Field label={t.bankCountry} id="v-bc" error={errorFor("v-bc")}>
                <input id="v-bc" className="field num" value={v.bankCountry} onChange={set("bankCountry")} maxLength={2} placeholder={t.example("VN")} {...fieldA11y("v-bc", errorFor("v-bc"))} />
              </Field>
              <Field label={t.bankCurrency} id="v-bcur" error={errorFor("v-bcur")}>
                <input id="v-bcur" className="field num" value={v.bankCurrency} onChange={set("bankCurrency")} maxLength={3} placeholder={t.example("VND")} {...fieldA11y("v-bcur", errorFor("v-bcur"))} />
              </Field>
            </div>
            <Field label={t.preferredRail} id="v-rail" error={errorFor("v-rail")}>
              <select id="v-rail" className="field" value={v.preferredRail} onChange={set("preferredRail")} {...fieldA11y("v-rail", errorFor("v-rail"))}>
                <option value="">{internal ? "Let the router choose" : t.noPreference}</option>
                <option value="paypal">PayPal</option>
                {internal || v.country !== "VN" ? <option value="stellar">Stellar (PYUSD)</option> : null}
                <option value="wise">{t.wise}</option>
                <option value="bank_file">{t.bankFile}</option>
              </select>
            </Field>
            {mode === "payout" && hasAccount ? (
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={dropAccount} onChange={(e) => setDropAccount(e.target.checked)} />
                Remove the bank account number on file (leave the number field empty to keep it)
              </label>
            ) : null}
            {mode === "payout" ? (
              <Field label="Why the change (optional)" id="v-note">
                <input id="v-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Vendor called: new PayPal account" />
              </Field>
            ) : null}
          </fieldset>
        ) : null}

        {problems.length ? (
          <div ref={summary} role="alert" tabIndex={-1} className="rounded-md border px-4 py-3 focus:outline-none focus-visible:outline-2" style={{ borderColor: "var(--blocked)", background: "var(--blocked-soft)" }}>
            <p className="flex items-start gap-2 font-medium text-blocked">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden className="mt-0.5 shrink-0">
                <circle cx="9" cy="9" r="7.25" />
                <path d="M6.5 6.5l5 5M11.5 6.5l-5 5" />
              </svg>
              <span>{t.errorTitle(problems.length)}</span>
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-[26px]">
              {problems.map((p, i) => (
                <li key={i}>
                  {p.field ? (
                    <a href={`#${p.field}`} className="link">
                      {t.errors[p.code]}
                    </a>
                  ) : (
                    t.errors[p.code]
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? t.saving : mode === "create" ? "Add vendor" : mode === "profile" ? "Save" : mode === "payout" ? "Request the change" : t.send}
        </button>
      </form>
    </>
  );
}

/** aria wiring for a field with an error message under it: invalid, described by the message, required when marked. */
function fieldA11y(id: string, error: string | undefined, required = false, hasHint = false) {
  const described = [hasHint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return { "aria-invalid": error ? true : undefined, "aria-describedby": described || undefined, "aria-required": required ? true : undefined };
}

function Field({ label, id, children, hint, error, required }: { label: string; id: string; children: React.ReactNode; hint?: string; error?: string; required?: string }) {
  return (
    <div>
      <label className="lbl" htmlFor={id}>
        {label}
        {required ? <span className="text-ink"> ({required})</span> : null}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="-mt-0.5 mb-1 text-xs leading-4 text-ink-soft">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs leading-4 text-blocked">
          {error}
        </p>
      ) : null}
    </div>
  );
}
