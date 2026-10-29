"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { applyCreditAction, createBillAction, payBillAction, settleAdvanceAction } from "@/app/actions";
import { formatMoney, stateLabel } from "@/lib/format";
import { useToast } from "./Toast";
import { DateField } from "./DateField";

export type BillRow = {
  id: string;
  kind: string;
  reference: string;
  totalMinor: number;
  currency: string;
  dueDate: string | null;
  status: string;
  note: string | null;
  balance: { paidMinor: number; pendingMinor: number; creditedMinor: number; openMinor: number };
  payments: Array<{ id: string; state: string; amountMinor: number | null; paymentKind: string | null }>;
};

const KIND: Record<string, string> = { invoice: "Invoice", credit_note: "Credit note", advance: "Advance" };
const toMinor = (v: string) => (v.trim() ? Math.round(Number(v.replace(/,/g, "")) * 100) : NaN);

/** What the business owes this vendor, bill by bill, and what is owed back. */
export function BillsPanel({ vendorId, rows, position, canIngest, canAmend, defaultCurrency }: { vendorId: string; rows: BillRow[]; position: Array<{ currency: string; owedMinor: number; creditMinor: number; advancesOutMinor: number }>; canIngest: boolean; canAmend: boolean; defaultCurrency: string }) {
  const [adding, setAdding] = useState(false);
  const credits = rows.filter((r) => r.kind === "credit_note" && r.status === "open" && r.balance.openMinor > 0);
  return (
    <div className="space-y-4">
      {position.length ? (
        <dl className="grid gap-3 sm:grid-cols-3">
          {position.map((p) => (
            <div key={p.currency} className="contents">
              <div>
                <dt className="dense text-ink-soft">Owed to them</dt>
                <dd className="num text-lg">{formatMoney(p.owedMinor, p.currency)}</dd>
              </div>
              <div>
                <dt className="dense text-ink-soft">Credit they owe back</dt>
                <dd className="num text-lg">{formatMoney(p.creditMinor, p.currency)}</dd>
              </div>
              <div>
                <dt className="dense text-ink-soft">Cash advanced, not yet settled</dt>
                <dd className="num text-lg">{formatMoney(p.advancesOutMinor, p.currency)}</dd>
              </div>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-ink-soft">No bills yet. Payments made in one go need none; record a bill for a deposit and balance, a credit note, or a cash advance.</p>
      )}
      {rows.length ? (
        <ul className="divide-y hairline border-y">
          {rows.map((r) => (
            <BillItem key={r.id} r={r} credits={credits.filter((c) => c.currency === r.currency)} canIngest={canIngest} canAmend={canAmend} />
          ))}
        </ul>
      ) : null}
      {canIngest ? adding ? <AddBill vendorId={vendorId} defaultCurrency={defaultCurrency} onDone={() => setAdding(false)} /> : (
        <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
          Record a bill, credit note or advance
        </button>
      ) : null}
    </div>
  );
}

function BillItem({ r, credits, canIngest, canAmend }: { r: BillRow; credits: BillRow[]; canIngest: boolean; canAmend: boolean }) {
  const [mode, setMode] = useState<null | "pay" | "credit" | "settle">(null);
  const [amount, setAmount] = useState(fmtInput(r.balance.openMinor, r.currency));
  const [creditId, setCreditId] = useState(credits[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const minor = toMinor(amount);
  const run = (fn: () => Promise<{ ok: boolean; message: string; id?: string }>) =>
    start(async () => {
      const res = await fn();
      toast(res.message, res.ok ? "ok" : "error");
      if (res.ok) {
        setMode(null);
        if (res.id) router.push(`/obligations/${res.id}`);
        else router.refresh();
      }
    });
  const open = r.status === "open";
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p>
          <span className="font-medium">
            {KIND[r.kind]} <span className="num">{r.reference}</span>
          </span>
          <span className="text-ink-soft"> · {r.status}{r.dueDate ? ` · due ${r.dueDate}` : ""}</span>
        </p>
        <p className="num">
          {r.kind === "credit_note" ? `${formatMoney(r.balance.openMinor, r.currency)} left of ${formatMoney(r.totalMinor, r.currency)}` : r.kind === "advance" ? `${formatMoney(r.balance.paidMinor, r.currency)} paid out of ${formatMoney(r.totalMinor, r.currency)}` : `${formatMoney(r.balance.openMinor, r.currency)} open of ${formatMoney(r.totalMinor, r.currency)}`}
        </p>
      </div>
      {r.note ? <p className="text-xs text-ink-soft">{r.note.replace(/\s*\((?:obligation |payment request )?obl_[a-z0-9]+\)/gi, "").replace(/\bobligation\b/gi, "request")}</p> : null}
      {r.payments.length ? (
        <p className="mt-1 text-xs text-ink-soft">
          {r.payments.map((p, i) => (
            <span key={p.id}>
              {i ? ", " : ""}
              <Link href={`/obligations/${p.id}`} className="link">
                {p.paymentKind ?? "payment"} {formatMoney(p.amountMinor, r.currency)} ({stateLabel(p.state).toLowerCase()})
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      {open && mode === null ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {canIngest && r.kind !== "credit_note" && r.balance.openMinor > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => setMode("pay")}>
              {r.kind === "advance" ? "Pay out the advance" : r.balance.paidMinor + r.balance.pendingMinor > 0 ? "Pay the balance" : "Pay"}
            </button>
          ) : null}
          {canAmend && r.kind === "invoice" && credits.length && r.balance.openMinor > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => { const c = credits.find((x) => x.id === creditId) ?? credits[0]; setAmount(fmtInput(Math.min(c.balance.openMinor, r.balance.openMinor), r.currency)); setMode("credit"); }}>
              Apply a credit
            </button>
          ) : null}
          {canAmend && r.kind === "advance" && r.balance.paidMinor > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => { setAmount(""); setMode("settle"); }}>
              Settle against receipts
            </button>
          ) : null}
        </div>
      ) : null}
      {mode ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!Number.isFinite(minor) || minor < 0) return;
            if (mode === "pay") run(() => payBillAction(r.id, minor, note || undefined));
            else if (mode === "credit") run(() => applyCreditAction(creditId, r.id, minor));
            else run(() => settleAdvanceAction(r.id, minor, note || undefined));
          }}
        >
          {mode === "credit" ? (
            <div>
              <label className="lbl" htmlFor={`cr-${r.id}`}>
                Credit note
              </label>
              <select id={`cr-${r.id}`} className="field" value={creditId} onChange={(e) => { setCreditId(e.target.value); const c = credits.find((x) => x.id === e.target.value); if (c) setAmount(fmtInput(Math.min(c.balance.openMinor, r.balance.openMinor), r.currency)); }}>
                {credits.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.reference} ({formatMoney(c.balance.openMinor, c.currency)} left)
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label className="lbl" htmlFor={`amt-${r.id}`}>
              {mode === "settle" ? `Receipts total (${r.currency})` : `Amount (${r.currency})`}
            </label>
            <input id={`amt-${r.id}`} className="field num" style={{ width: "9rem" }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {mode !== "credit" ? <input aria-label="Note" className="field" style={{ width: "14rem" }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={mode === "settle" ? "Receipts photographed in the chat" : "Note (optional)"} /> : null}
          <button type="submit" className="btn btn-sm btn-primary" disabled={pending || !Number.isFinite(minor) || (mode !== "settle" && minor <= 0)}>
            {pending ? "Saving" : mode === "pay" ? "Request payment" : mode === "credit" ? "Apply" : "Settle"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setMode(null)}>
            Never mind
          </button>
        </form>
      ) : null}
    </li>
  );
}

function AddBill({ vendorId, defaultCurrency, onDone }: { vendorId: string; defaultCurrency: string; onDone: () => void }) {
  const [kind, setKind] = useState("invoice");
  const [reference, setReference] = useState("");
  const [total, setTotal] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const minor = toMinor(total);
  return (
    <form
      className="grid gap-3 rounded border p-3 hairline sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createBillAction(vendorId, { kind, reference, totalMinor: minor, currency, dueDate: dueDate || null, note: note || null });
          toast(r.message, r.ok ? "ok" : "error");
          if (r.ok) {
            onDone();
            router.refresh();
          }
        });
      }}
    >
      <div>
        <label className="lbl" htmlFor="b-kind">
          What
        </label>
        <select id="b-kind" className="field" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="invoice">Invoice (pay in parts)</option>
          <option value="credit_note">Credit note from the vendor</option>
          <option value="advance">Cash advance before a trip</option>
        </select>
      </div>
      <div>
        <label className="lbl" htmlFor="b-ref">
          Reference
        </label>
        <input id="b-ref" className="field num" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={64} placeholder={kind === "advance" ? "ADV-HG-1004" : kind === "credit_note" ? "CN-0007" : "INV-1010"} required />
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <label className="lbl" htmlFor="b-total">
            Total
          </label>
          <input id="b-total" className="field num" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} required />
        </div>
        <div>
          <label className="lbl" htmlFor="b-cur">
            Currency
          </label>
          <select id="b-cur" className="field" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["USD", "VND", "PHP", "THB"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="lbl" htmlFor="b-due">
          Due (optional)
        </label>
        <DateField id="b-due" value={dueDate} onChange={setDueDate} style={{ width: "100%" }} />
      </div>
      <div className="sm:col-span-2">
        <label className="lbl" htmlFor="b-note">
          Note (optional)
        </label>
        <input id="b-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={kind === "credit_note" ? "Two rooms cancelled on INV-0919" : kind === "advance" ? "Fuel, park tickets and meals for HG-4D-1004" : ""} />
      </div>
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !Number.isFinite(minor) || minor <= 0 || !reference.trim()}>
          {pending ? "Saving" : "Record"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Never mind
        </button>
      </div>
    </form>
  );
}

/** An amount for an input box: what the credit or bill leaves, in the currency's usual decimals. */
function fmtInput(minor: number, currency: string): string {
  return (minor / 100).toFixed(currency === "VND" ? 0 : 2);
}
