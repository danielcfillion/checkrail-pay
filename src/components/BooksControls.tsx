"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reconcilePayPalAction, reconcilePayPalLiveAction, setPeriodLockAction } from "@/app/actions";
import { useToast } from "./Toast";

export function ReconcileUpload({ primary = true }: { primary?: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <label className={`btn inline-flex cursor-pointer ${primary ? "btn-primary" : ""}`}>
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

/** Read the statement straight from PayPal Transaction Search. Live rails only; the button explains itself otherwise. */
export function ReconcileFromPayPal({ live, defaultFrom, defaultTo }: { live: boolean; defaultFrom: string; defaultTo: string }) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await reconcilePayPalLiveAction(from, to);
          toast(r.message, r.ok ? "ok" : "error");
          router.refresh();
        });
      }}
    >
      <div>
        <label className="lbl" htmlFor="recon-from">
          From
        </label>
        <input id="recon-from" type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!live} />
      </div>
      <div>
        <label className="lbl" htmlFor="recon-to">
          To
        </label>
        <input id="recon-to" type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} disabled={!live} />
      </div>
      <button type="submit" className="btn btn-primary" disabled={!live || pending || !from || !to}>
        {pending ? "Reading PayPal" : "Read from PayPal"}
      </button>
      {!live ? <p className="w-full text-xs text-ink-soft">Needs live PayPal keys. On simulated rails, upload the activity CSV below.</p> : null}
    </form>
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
