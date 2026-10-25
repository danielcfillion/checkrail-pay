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
const COUNTRIES: Array<[string, string]> = [
  ["VN", "Vietnam"],
  ["PH", "Philippines"],
  ["TH", "Thailand"],
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
];

type Mode = "create" | "profile" | "payout" | "onboard-new" | "onboard-existing";

/** The vendor-facing form in Vietnamese. Internal screens stay in English. */
const VI: Record<string, string> = {
  "Who you are": "Bạn là ai",
  "About you": "Về bạn",
  "Your name or business name": "Tên của bạn hoặc tên cơ sở kinh doanh",
  "Name": "Tên",
  "What you do": "Bạn làm gì",
  "Country": "Quốc gia",
  "Email": "Email",
  "Phone, with country code": "Số điện thoại, kèm mã quốc gia",
  "Tax code (MST) or ID number (CCCD), optional": "Mã số thuế (MST) hoặc số CCCD, không bắt buộc",
  "Tax ID (TIN), optional": "Mã số thuế (TIN), không bắt buộc",
  "I am paid as": "Tôi nhận tiền với tư cách",
  "Choose": "Chọn",
  "An individual": "Cá nhân",
  "A business": "Doanh nghiệp",
  "Where you want to be paid": "Bạn muốn nhận tiền ở đâu",
  "Give at least one. The business will confirm these with you before the first payment.": "Điền ít nhất một cách. Doanh nghiệp sẽ xác nhận lại với bạn trước lần thanh toán đầu tiên.",
  "PayPal email": "Email PayPal",
  "Stellar account (public key)": "Tài khoản Stellar (khóa công khai)",
  "Bank account number": "Số tài khoản ngân hàng",
  "Bank": "Ngân hàng",
  "Bank code": "Mã ngân hàng",
  "Name on the account": "Tên chủ tài khoản",
  "Bank country": "Quốc gia của ngân hàng",
  "Bank currency": "Loại tiền",
  "Preferred way to be paid": "Cách nhận tiền mong muốn",
  "No preference": "Không có yêu cầu",
  "Bank transfer through Wise": "Chuyển khoản qua Wise",
  "Bank transfer, domestic file (Vietnam)": "Chuyển khoản trong nước (Việt Nam)",
  "Send my details": "Gửi thông tin",
  "Saving": "Đang gửi",
  "Guide": "Hướng dẫn viên",
  "Driver": "Tài xế",
  "Homestay": "Homestay",
  "Hotel": "Khách sạn",
  "Creator": "Sáng tạo nội dung",
  "Supplier": "Nhà cung cấp",
  "Contractor": "Nhà thầu",
  "Vietnam": "Việt Nam",
  "Philippines": "Philippines",
  "Thailand": "Thái Lan",
  "United States": "Hoa Kỳ",
  "Canada": "Canada",
  "United Kingdom": "Vương quốc Anh",
};

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
export function VendorForm({ mode, initial = EMPTY_VENDOR, vendorId, token, hasAccount = false, lang = "en" }: { mode: Mode; initial?: VendorFormValues; vendorId?: string; token?: string; hasAccount?: boolean; lang?: "en" | "vi" }) {
  const tr = (en: string) => (lang === "vi" && (mode === "onboard-new" || mode === "onboard-existing") ? VI[en] ?? en : en);
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
          <legend className="mb-2 font-medium">{internal ? "Who they are" : tr("About you")}</legend>
          <Field label={internal ? "Name" : tr("Your name or business name")} id="v-name">
            <input id="v-name" className="field" value={v.name} onChange={set("name")} required maxLength={80} autoComplete="organization" />
          </Field>
          <Field label={tr("What you do")} id="v-role">
            <select id="v-role" className="field" value={v.role} onChange={set("role")}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {tr(r.charAt(0).toUpperCase() + r.slice(1))}
                </option>
              ))}
            </select>
          </Field>
          <Field label={tr("Country")} id="v-country">
            <select id="v-country" className="field" value={v.country} onChange={set("country")}>
              {COUNTRIES.map(([c, n]) => (
                <option key={c} value={c}>
                  {tr(n)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={tr("Email")} id="v-email">
            <input id="v-email" type="email" className="field" value={v.email} onChange={set("email")} maxLength={254} autoComplete="email" />
          </Field>
          <Field label={internal ? "Phone, with country code (used to call back about bank changes)" : tr("Phone, with country code")} id="v-phone">
            <input id="v-phone" type="tel" className="field num" value={v.phone ?? ""} onChange={set("phone")} maxLength={24} autoComplete="tel" placeholder="+84 912 345 678" />
          </Field>
          <Field label={tr(v.country === "VN" ? "Tax code (MST) or ID number (CCCD), optional" : "Tax ID (TIN), optional")} id="v-taxid">
            <input id="v-taxid" className="field num" value={v.taxId ?? ""} onChange={set("taxId")} maxLength={20} autoComplete="off" />
          </Field>
          {!internal ? (
            <Field label={tr("I am paid as")} id="v-taxtype2">
              <select id="v-taxtype2" className="field" value={v.taxType ?? ""} onChange={set("taxType")}>
                <option value="">{tr("Choose")}</option>
                <option value="individual">{tr("An individual")}</option>
                <option value="business">{tr("A business")}</option>
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
                  <option value="individual">{tr("An individual")}</option>
                  <option value="business">{tr("A business")}</option>
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
          <legend className="mb-2 font-medium">{internal || mode === "payout" ? "Where payments go" : tr("Where you want to be paid")}</legend>
          <p className="text-sm text-ink-soft sm:col-span-2">
            {mode === "payout"
              ? "These replace the details on file once someone else confirms them with the vendor on a number or address you already have. Until then, payments keep going to the current details."
              : internal
                ? "Give at least one. The vendor cannot be paid until someone other than you has confirmed these with them."
                : tr("Give at least one. The business will confirm these with you before the first payment.")}
          </p>
          <Field label={tr("PayPal email")} id="v-pp">
            <input id="v-pp" type="email" className="field" value={v.paypalEmail} onChange={set("paypalEmail")} maxLength={254} />
          </Field>
          {internal || mode === "payout" || v.country === "PH" || v.stellarAccount ? (
            <Field label={tr("Stellar account (public key)")} id="v-xlm">
              <input id="v-xlm" className="field num" value={v.stellarAccount} onChange={set("stellarAccount")} maxLength={56} placeholder="G..." spellCheck={false} />
            </Field>
          ) : null}
          <Field label={tr("Bank account number")} id="v-acct">
            <input id="v-acct" className="field num" value={v.bankAccountNumber} onChange={set("bankAccountNumber")} maxLength={34} inputMode="numeric" autoComplete="off" placeholder={initial.bankLabel ? `on file: ${initial.bankLabel}` : "0071000123456"} />
          </Field>
          {(v.bankCountry || v.country) === "VN" ? (
            <Field label={tr("Bank")} id="v-bcode">
              <select id="v-bcode" className="field" value={v.bankCode} onChange={(e) => setV({ ...v, bankCode: e.target.value, bankCountry: v.bankCountry || "VN", bankCurrency: v.bankCurrency || "VND" })}>
                <option value="">{tr("Choose")}</option>
                {VN_BANKS.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name} ({code})
                  </option>
                ))}
                {v.bankCode && !VN_BANKS.some(([c]) => c === v.bankCode) ? <option value={v.bankCode}>{v.bankCode}</option> : null}
              </select>
            </Field>
          ) : (
            <Field label={tr("Bank code")} id="v-bcode">
              <input id="v-bcode" className="field num" value={v.bankCode} onChange={set("bankCode")} maxLength={11} placeholder="BDO, BPI, KBANK" />
            </Field>
          )}
          <Field label={tr("Name on the account")} id="v-holder">
            <input id="v-holder" className="field" value={v.accountHolder} onChange={set("accountHolder")} maxLength={70} placeholder="NGUYEN THI LINH" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr("Bank country")} id="v-bc">
              <input id="v-bc" className="field num" value={v.bankCountry} onChange={set("bankCountry")} maxLength={2} placeholder="VN" />
            </Field>
            <Field label={tr("Bank currency")} id="v-bcur">
              <input id="v-bcur" className="field num" value={v.bankCurrency} onChange={set("bankCurrency")} maxLength={3} placeholder="VND" />
            </Field>
          </div>
          <Field label={tr("Preferred way to be paid")} id="v-rail">
            <select id="v-rail" className="field" value={v.preferredRail} onChange={set("preferredRail")}>
              <option value="">{internal ? "Let the router choose" : tr("No preference")}</option>
              <option value="paypal">PayPal</option>
              <option value="stellar">Stellar (PYUSD)</option>
              <option value="wise">{tr("Bank transfer through Wise")}</option>
              <option value="bank_file">{tr("Bank transfer, domestic file (Vietnam)")}</option>
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
        {pending ? tr("Saving") : mode === "create" ? "Add vendor" : mode === "profile" ? "Save" : mode === "payout" ? "Request the change" : tr("Send my details")}
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
