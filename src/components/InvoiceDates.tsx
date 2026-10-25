"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setDatesAction } from "@/app/actions";
import { formatDate } from "@/lib/format";
import { useToast } from "./Toast";

/** The invoice and due dates, read from the documents; a person can correct them without touching the approval. */
export function InvoiceDates({ id, invoiceDate, dueDate, editable }: { id: string; invoiceDate: string | null; dueDate: string | null; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const [inv, setInv] = useState(invoiceDate ?? "");
  const [due, setDue] = useState(dueDate ?? "");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <>
      <dt className="text-ink-soft">Invoice date</dt>
      <dd>{invoiceDate ? formatDate(invoiceDate) : <span className="text-ink-soft">not on the invoice</span>}</dd>
      <dt className="text-ink-soft">Due</dt>
      <dd className="flex flex-wrap items-center gap-2">
        {dueDate ? formatDate(dueDate) : <span className="text-ink-soft">no due date</span>}
        {editable && !open ? (
          <button type="button" className="link text-xs" onClick={() => setOpen(true)}>
            Change dates
          </button>
        ) : null}
      </dd>
      {open ? (
        <dd className="col-span-2">
          <form
            className="mt-1 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await setDatesAction(id, { invoiceDate: inv || null, dueDate: due || null });
                toast(r.message, r.ok ? "ok" : "error");
                if (r.ok) {
                  setOpen(false);
                  router.refresh();
                }
              });
            }}
          >
            <label className="text-xs">
              <span className="lbl">Invoice date</span>
              <input type="date" className="field num" value={inv} onChange={(e) => setInv(e.target.value)} />
            </label>
            <label className="text-xs">
              <span className="lbl">Due</span>
              <input type="date" className="field num" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-sm btn-primary" disabled={pending}>
              {pending ? "Saving" : "Save dates"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        </dd>
      ) : null}
    </>
  );
}
