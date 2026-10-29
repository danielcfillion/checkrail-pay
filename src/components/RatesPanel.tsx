"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importDeparturesAction, setRateAction } from "@/app/actions";
import { formatMoney } from "@/lib/format";
import { useToast } from "./Toast";
import { DateField } from "./DateField";

const UNITS: Array<[string, string]> = [
  ["day", "per day"],
  ["vehicle_day", "per vehicle-day"],
  ["guest_night", "per guest-night"],
  ["room_night", "per room-night"],
  ["guest", "per guest"],
  ["trip", "per trip"],
];
const unitLabel = (u: string) => UNITS.find(([k]) => k === u)?.[1] ?? u;

export type RateRow = { id: string; unit: string; rateMinor: number; currency: string; validFrom: string; validTo: string | null; note: string | null };

export function RatesPanel({ vendorId, rows, canSet, defaultCurrency }: { vendorId: string; rows: RateRow[]; canSet: boolean; defaultCurrency: string }) {
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState("day");
  const [rate, setRate] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const minor = rate.trim() ? Math.round(Number(rate.replace(/,/g, "")) * 100) : NaN;
  return (
    <div className="space-y-3">
      {rows.length ? (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.id} className={r.validTo && r.validTo < new Date().toISOString().slice(0, 10) ? "text-ink-soft line-through" : ""}>
              <span className="num">{formatMoney(r.rateMinor, r.currency)}</span> {unitLabel(r.unit)}
              <span className="text-xs text-ink-soft">
                {" "}
                from {r.validFrom}
                {r.validTo ? ` to ${r.validTo}` : ""}
                {r.note ? `. ${r.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-soft">No rates. With a rate and a departure, an invoice above what the job should cost is stopped automatically.</p>
      )}
      {canSet ? (
        open ? (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await setRateAction(vendorId, { unit, rateMinor: minor, currency, validFrom: from, note: note || null });
                toast(r.message, r.ok ? "ok" : "error");
                if (r.ok) {
                  setOpen(false);
                  router.refresh();
                }
              });
            }}
          >
            <div className="flex gap-2">
              <input aria-label="Rate" className="field num" style={{ width: "7rem" }} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="200" required />
              <select aria-label="Currency" className="field" style={{ width: "5.5rem" }} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {["USD", "VND", "PHP", "THB"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <select aria-label="Unit" className="field" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {UNITS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <DateField aria-label="Valid from" value={from} onChange={setFrom} required style={{ width: "100%" }} />
            <input aria-label="Note" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Contract 2026" />
            <div className="flex gap-2 sm:col-span-2">
              <button type="submit" className="btn btn-sm btn-primary" disabled={pending || !Number.isFinite(minor) || minor <= 0}>
                {pending ? "Saving" : "Save rate"}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
                Never mind
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            Add or change a rate
          </button>
        )
      ) : null}
    </div>
  );
}

export function ImportDepartures() {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  const router = useRouter();
  const { toast } = useToast();
  return (
    <div className="space-y-2">
      <label className="btn btn-primary inline-flex cursor-pointer">
        {pending ? "Importing" : "Import a manifest CSV"}
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          disabled={pending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > 500_000) return toast("File too large (500 KB at most)", "error");
            start(async () => {
              const r = await importDeparturesAction(await f.text());
              toast(r.message, r.ok ? "ok" : "error");
              setErrors(r.ok ? (r.errors ?? []) : []);
              router.refresh();
            });
          }}
        />
      </label>
      {errors.length ? (
        <ul className="text-xs text-attention">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
