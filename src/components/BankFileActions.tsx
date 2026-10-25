"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmBankFileAction, returnBankLineAction } from "@/app/actions";
import { ConfirmButton } from "./ConfirmButton";
import { useToast } from "./Toast";

export function ConfirmBankFile({ batchId, count }: { batchId: string; count: number }) {
  return <ConfirmButton label="The bank paid it" busyLabel="Confirming" tone="primary" confirmText={`Mark all ${count} payment${count === 1 ? "" : "s"} in this file as paid? Do this once the bank statement or the bank's upload result shows them paid.`} action={() => confirmBankFileAction(batchId)} />;
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
