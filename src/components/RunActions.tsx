"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveAction, cancelRunAction, releaseRunAction, removeRunItemAction } from "@/app/actions";
import { useToast } from "./Toast";
import { ConfirmButton } from "./ConfirmButton";

export function ReleaseRun({ runId, label, confirmText, disabled }: { runId: string; label: string; confirmText: string; disabled?: boolean }) {
  if (disabled)
    return (
      <button type="button" className="btn btn-primary" disabled>
        {label}
      </button>
    );
  return <ConfirmButton label={label} busyLabel="Releasing" tone="primary" confirmText={confirmText} action={() => releaseRunAction(runId)} />;
}

export function CancelRun({ runId }: { runId: string }) {
  return <ConfirmButton label="Cancel run" busyLabel="Cancelling" tone="danger" confirmText="Cancel this run? Nothing in it is paid; each payment stays where it is." action={() => cancelRunAction(runId)} />;
}

export function RemoveItem({ runId, itemId }: { runId: string; itemId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await removeRunItemAction(runId, itemId);
          toast(r.message, r.ok ? "ok" : "error");
          router.refresh();
        })
      }
    >
      Remove
    </button>
  );
}

/**
 * Approve one waiting item without leaving the run. It sends the fingerprints of the warnings this page showed, the same
 * way the payment page does, so the approval covers exactly what the person saw: a warning that appeared since is refused.
 */
export function ApproveItem({ obligationId, fingerprints, label }: { obligationId: string; fingerprints: string[]; label: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      disabled={pending}
      aria-label={label}
      onClick={() =>
        start(async () => {
          const r = await approveAction(obligationId, undefined, fingerprints);
          toast(r.message, r.ok ? "ok" : "error");
          router.refresh();
        })
      }
    >
      {pending ? "Approving" : "Approve"}
    </button>
  );
}
