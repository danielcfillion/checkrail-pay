"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createRunAction } from "@/app/actions";
import { formatMoney } from "@/lib/format";
import { useToast } from "./Toast";

export type Candidate = { id: string; vendorName: string | null; sourceRef: string | null; amountMinor: number; currency: string; dueDate: string | null; state: string; rail: string | null; scheduled: boolean };

/** Tick what is due, see the total, make a run. */
export function RunBuilder({ rows, defaultName }: { rows: Candidate[]; defaultName: string }) {
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
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col" className="w-8">
                <input type="checkbox" aria-label="Select all" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.id)))} />
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
                  <input type="checkbox" aria-label={`Include ${r.vendorName ?? r.id}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                </td>
                <td className="font-medium">
                  <Link href={`/obligations/${r.id}`} className="hover:underline">
                    {r.vendorName ?? "Unknown vendor"}
                  </Link>
                </td>
                <td className="num hidden text-ink-soft sm:table-cell">{r.sourceRef ?? "none"}</td>
                <td className="num hidden text-ink-soft md:table-cell">{r.dueDate ?? "none"}</td>
                <td className="text-ink-soft">{r.state === "approved" ? (r.scheduled ? "approved, autopilot scheduled" : "approved") : "waiting for approval"}</td>
                <td className="hidden text-ink-soft sm:table-cell">{r.rail ?? "none"}</td>
                <td className="r num">{formatMoney(r.amountMinor, r.currency)}</td>
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
