"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmBankFileAction, returnBankLineAction } from "@/app/actions";
import { ConfirmButton } from "./ConfirmButton";
import { useToast } from "./Toast";

export function ConfirmBankFile({ batchId, count }: { batchId: string; count: number }) {
  const [ref, setRef] = useState("");
  const ok = /^[A-Za-z0-9 ._/:#-]{4,64}$/.test(ref.trim());
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label="The bank's reference for this upload" className="field num" style={{ width: "12rem" }} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={64} placeholder="Bank reference" />
      {ok ? (
        <ConfirmButton label="The bank paid it" busyLabel="Confirming" tone="primary" confirmText={`Mark all ${count} payment${count === 1 ? "" : "s"} in this file as paid, with bank reference ${ref.trim()}? Do this once the bank's upload result or statement shows them paid.`} action={() => confirmBankFileAction(batchId, ref.trim())} />
      ) : (
        <span className="text-xs text-ink-soft">Enter the bank&apos;s reference from its result screen or statement to confirm</span>
      )}
    </div>
  );
}

export function ReturnLine({ lineId }: { lineId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  if (!open)
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Returned
      </button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await returnBankLineAction(lineId, reason);
          toast(r.message, r.ok ? "ok" : "error");
          router.refresh();
        });
      }}
    >
      <input aria-label="Why the bank returned it" className="field" style={{ width: "11rem" }} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Account closed" required />
      <button type="submit" className="btn btn-sm btn-danger" disabled={pending || !reason.trim()}>
        Record return
      </button>
    </form>
  );
}
