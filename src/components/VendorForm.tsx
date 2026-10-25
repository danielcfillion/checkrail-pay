"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVendorAction, proposePayoutAction, updateVendorAction } from "@/app/actions";
import { submitOnboardingAction } from "@/app/onboard/actions";
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
};

export const EMPTY_VENDOR: VendorFormValues = { name: "", role: "guide", country: "VN", email: "", notes: "", defaultAccountCode: "", preferredRail: "", paypalEmail: "", stellarAccount: "", bankCountry: "", bankCurrency: "", bankLabel: "", bankAccountNumber: "", bankCode: "", accountHolder: "" };

const ROLES = ["guide", "driver", "homestay", "hotel", "creator", "supplier", "contractor"];
const COUNTRIES: Array<[string, string]> = [
  ["VN", "Vietnam"],
  ["PH", "Philippines"],
  ["TH", "Thailand"],
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
];

type Mode = "create" | "profile" | "payout" | "onboard-new" | "onboard-existing";

/**
 * One form for the vendor master: add a vendor, edit their profile, request new payout details, or (on the public
 * onboarding page) let the vendor enter their own. Payout fields are never saved straight onto the vendor.
 */
export function VendorForm({ mode, initial = EMPTY_VENDOR, vendorId, token, hasAccount = false }: { mode: Mode; initial?: VendorFormValues; vendorId?: string; token?: string; hasAccount?: boolean }) {
  const [v, setV] = useState<VendorFormValues>(initial);
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

  const profile = { name: v.name, role: v.role, country: v.country, email: v.email || null, notes: v.notes || null, defaultAccountCode: v.defaultAccountCode || null };
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
        const r = await submitOnboardingAction(token!, { profile: mode === "onboard-new" ? profile : undefined, payout });
        if (r.ok) setDone(r.message);
        else toast(r.message, "error");
      }
    });

  if (done) return <p className="panel p-5">{done}</p>;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {showProfile ? (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-medium">{internal ? "Who they are" : "About you"}</legend>
          <Field label={internal ? "Name" : "Your name or business name"} id="v-name">
            <input id="v-name" className="field" value={v.name} onChange={set("name")} required maxLength={80} autoComplete="organization" />
          </Field>
          <Field label="What you do" id="v-role">
            <select id="v-role" className="field" value={v.role} onChange={set("role")}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Country" id="v-country">
            <select id="v-country" className="field" value={v.country} onChange={set("country")}>
              {COUNTRIES.map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Email" id="v-email">
            <input id="v-email" type="email" className="field" value={v.email} onChange={set("email")} maxLength={254} autoComplete="email" />
          </Field>
          {internal ? (
            <>
              <Field label="Account code for the books (optional)" id="v-code">
                <input id="v-code" className="field num" value={v.defaultAccountCode} onChange={set("defaultAccountCode")} maxLength={20} placeholder="5100" />
              </Field>
              <Field label="Notes (optional)" id="v-notes">
                <input id="v-notes" className="field" value={v.notes} onChange={set("notes")} maxLength={500} />
              </Field>
            </>
          ) : null}
        </fieldset>
      ) : null}

      {showPayout ? (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-medium">{internal || mode === "payout" ? "Where payments go" : "Where you want to be paid"}</legend>
          <p className="text-sm text-ink-soft sm:col-span-2">
            {mode === "payout"
              ? "These replace the details on file once someone else confirms them with the vendor on a number or address you already have. Until then, payments keep going to the current details."
              : internal
                ? "Give at least one. The vendor cannot be paid until someone other than you has confirmed these with them."
                : "Give at least one. The business will confirm these with you before the first payment."}
          </p>
          <Field label="PayPal email" id="v-pp">
            <input id="v-pp" type="email" className="field" value={v.paypalEmail} onChange={set("paypalEmail")} maxLength={254} />
          </Field>
          <Field label="Stellar account (public key)" id="v-xlm">
            <input id="v-xlm" className="field num" value={v.stellarAccount} onChange={set("stellarAccount")} maxLength={56} placeholder="G..." spellCheck={false} />
          </Field>
          <Field label="Bank account number" id="v-acct">
            <input id="v-acct" className="field num" value={v.bankAccountNumber} onChange={set("bankAccountNumber")} maxLength={34} inputMode="numeric" autoComplete="off" placeholder={initial.bankLabel ? `on file: ${initial.bankLabel}` : "0071000123456"} />
          </Field>
          <Field label="Bank code" id="v-bcode">
            <input id="v-bcode" className="field num" value={v.bankCode} onChange={set("bankCode")} maxLength={11} placeholder="VCB, TCB, BIDV, BDO, BPI" />
          </Field>
          <Field label="Name on the account" id="v-holder">
            <input id="v-holder" className="field" value={v.accountHolder} onChange={set("accountHolder")} maxLength={70} placeholder="NGUYEN THI LINH" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bank country" id="v-bc">
              <input id="v-bc" className="field num" value={v.bankCountry} onChange={set("bankCountry")} maxLength={2} placeholder="VN" />
            </Field>
            <Field label="Bank currency" id="v-bcur">
              <input id="v-bcur" className="field num" value={v.bankCurrency} onChange={set("bankCurrency")} maxLength={3} placeholder="VND" />
            </Field>
          </div>
          <Field label="Preferred way to be paid" id="v-rail">
            <select id="v-rail" className="field" value={v.preferredRail} onChange={set("preferredRail")}>
              <option value="">{internal ? "Let the router choose" : "No preference"}</option>
              <option value="paypal">PayPal</option>
              <option value="stellar">Stellar (PYUSD)</option>
              <option value="wise">Bank transfer through Wise</option>
              <option value="bank_file">Bank transfer, domestic file (Vietnam)</option>
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

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving" : mode === "create" ? "Add vendor" : mode === "profile" ? "Save" : mode === "payout" ? "Request the change" : "Send my details"}
      </button>
    </form>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}
