"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createRunAction } from "@/app/actions";
import { formatDate, formatMoney, railLabel } from "@/lib/format";
import { useToast } from "./Toast";
import { DateField } from "./DateField";
import { StatePill } from "./ui";

export type Candidate = { id: string; vendorName: string | null; sourceRef: string | null; amountMinor: number; currency: string; dueDate: string | null; state: string; rail: string | null; scheduled: boolean };

/** Tick what is due, see the total, make a run. */
export function RunBuilder({ rows, defaultName, today = "" }: { rows: Candidate[]; defaultName: string; today?: string }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rows.filter((r) => !r.scheduled).map((r) => r.id)));
  const [name, setName] = useState(defaultName);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (picked.has(r.id)) m.set(r.currency, (m.get(r.currency) ?? 0) + r.amountMinor);
    return [...m.entries()];
  }, [rows, picked]);
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const all = picked.size === rows.length;
  const [dueBy, setDueBy] = useState("");
  const pickDueBy = (d: string) => {
    setDueBy(d);
    // Everything due on or before the date (payments with no due date are left for a person to pick).
    if (d) setPicked(new Set(rows.filter((r) => !r.scheduled && r.dueDate && r.dueDate <= d).map((r) => r.id)));
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <div>
          <label className="lbl" htmlFor="run-due-by">
            Pick everything due by
          </label>
          <DateField id="run-due-by" value={dueBy} onChange={pickDueBy} />
        </div>
        {dueBy ? <span className="text-xs text-ink-soft">{rows.filter((r) => !r.dueDate).length} without a due date are not picked</span> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col" className="w-8">
                <label className="tap-check">
                  <input type="checkbox" aria-label="Select all" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.id)))} />
                </label>
              </th>
              <th scope="col">Vendor</th>
              <th scope="col" className="hidden sm:table-cell">Reference</th>
              <th scope="col" className="hidden md:table-cell">Due</th>
              <th scope="col">Status</th>
              <th scope="col" className="hidden sm:table-cell">Rail</th>
              <th scope="col" className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <label className="tap-check">
                    <input type="checkbox" aria-label={`Include ${r.vendorName ?? r.id}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                  </label>
                </td>
                <td className="font-medium">
                  <Link href={`/obligations/${r.id}`} className="hover:underline">
                    {r.vendorName ?? "Unknown vendor"}
                  </Link>
                </td>
                <td className="num hidden whitespace-nowrap text-ink-soft sm:table-cell">{r.sourceRef ?? "none"}</td>
                <td className={`num hidden whitespace-nowrap md:table-cell ${r.dueDate && r.dueDate < today ? "text-attention" : "text-ink-soft"}`}>{r.dueDate ? formatDate(r.dueDate) : "none"}</td>
                <td className="whitespace-nowrap">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatePill state={r.state} />
                    {r.scheduled ? <span className="text-xs text-attention">autopilot scheduled</span> : null}
                  </span>
                </td>
                <td className="hidden text-ink-soft sm:table-cell">{r.rail ? railLabel(r.rail) : "none"}</td>
                <td className="r num whitespace-nowrap">{formatMoney(r.amountMinor, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await createRunAction(name, [...picked]);
            toast(r.message, r.ok ? "ok" : "error");
            if (r.ok && r.id) router.push(`/runs/${r.id}`);
          });
        }}
      >
        <div>
          <label className="lbl" htmlFor="run-name">
            Run name
          </label>
          <input id="run-name" className="field" style={{ width: "14rem" }} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
        <p className="num pb-2">
          {picked.size} selected{totals.length ? `, ${totals.map(([c, m]) => formatMoney(m, c)).join(" + ")}` : ""}
        </p>
        <button type="submit" className="btn btn-primary" disabled={pending || picked.size === 0}>
          {pending ? "Creating" : "Create run"}
        </button>
      </form>
    </div>
  );
}
