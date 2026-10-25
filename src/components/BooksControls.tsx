"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reconcilePayPalAction, setPeriodLockAction } from "@/app/actions";
import { useToast } from "./Toast";

export function ReconcileUpload() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <label className="btn btn-primary inline-flex cursor-pointer">
      {pending ? "Reconciling" : "Upload PayPal activity CSV"}
      <input
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        disabled={pending}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > 5_000_000) return toast("File too large (5 MB at most)", "error");
          start(async () => {
            const r = await reconcilePayPalAction(f.name, await f.text());
            toast(r.message, r.ok ? "ok" : "error");
            router.refresh();
          });
        }}
      />
    </label>
  );
}

export function PeriodLock({ current, canLock, canReopen }: { current: string | null; canLock: boolean; canReopen: boolean }) {
  const [date, setDate] = useState(current ?? "");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const run = (v: string | null) =>
    start(async () => {
      const r = await setPeriodLockAction(v);
      toast(r.message, r.ok ? "ok" : "error");
      router.refresh();
    });
  if (!canLock) return <p className="text-ink-soft">{current ? `Closed through ${current}.` : "No period is closed."} The accountant or the owner closes periods.</p>;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (date) run(date);
      }}
    >
      <div>
        <label className="lbl" htmlFor="lock-date">
          Closed through
        </label>
        <input id="lock-date" type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <button type="submit" className="btn btn-primary" disabled={pending || !date || date === current}>
        {pending ? "Saving" : "Close the books"}
      </button>
      {current && canReopen ? (
        <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run(null)}>
          Reopen all
        </button>
      ) : null}
    </form>
  );
}
