"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { amendAction, approveAction, confirmAction, executeAction, rejectAction, type ActionResult } from "@/app/actions";
import type { Rail } from "@/lib/domain/types";
import { evidencedAmountFromReason, formatMoney, railLabel } from "@/lib/format";
import { useToast } from "./Toast";
import { useStage } from "./ObligationStage";

type Props = {
  id: string;
  state: string;
  amountMinor: number | null;
  currency: string | null;
  blockedReason: string | null;
  selectedRail: string | null;
  availableRails: Rail[];
  hasAccounting: boolean;
};

/**
 * The actions a person can take, by state. Each button names the action.
 * On a successful payment the check line marker travels to paid, then reconciled.
 */
export function ActionBar(p: Props) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();
  const { toast } = useToast();
  const { travel } = useStage();

  const run = (label: string, fn: () => Promise<ActionResult>, after?: (r: ActionResult) => void) => {
    setBusy(label);
    start(async () => {
      const r = await fn();
      toast(r.message, r.ok ? "ok" : "error");
      after?.(r);
      setBusy(null);
      router.refresh();
    });
  };

  const pay = (rail: Rail) =>
    run(`pay-${rail}`, () => executeAction(p.id, rail), (r) => {
      if (r.ok) {
        travel(3);
        setTimeout(() => travel(4), 700);
        setTimeout(() => travel(undefined), 1800);
      }
    });

  switch (p.state) {
    case "awaiting_approval":
      return (
        <div className="space-y-3">
          <div>
            <label className="lbl" htmlFor="approval-note">
              Note (optional)
            </label>
            <input id="approval-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Checked against the trip sheet" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => run("approve", () => approveAction(p.id, note || undefined))}>
              {busy === "approve" ? "Approving" : "Approve"}
            </button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, note || undefined))}>
              {busy === "reject" ? "Rejecting" : "Reject"}
            </button>
          </div>
          <p className="text-xs text-ink-soft">Approving does not pay. Policy re-checks, then the obligation becomes ready to pay.</p>
        </div>
      );

    case "approved": {
      const primary = (p.selectedRail as Rail | null) ?? p.availableRails[0] ?? null;
      const others = p.availableRails.filter((r) => r !== primary);
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {primary ? (
              <button type="button" className="btn btn-primary" disabled={pending} onClick={() => pay(primary)}>
                {busy === `pay-${primary}` ? `Paying with ${railLabel(primary)}` : `Pay with ${railLabel(primary)}`}
              </button>
            ) : null}
            {others.map((r) => (
              <button key={r} type="button" className="btn" disabled={pending} onClick={() => pay(r)}>
                {busy === `pay-${r}` ? `Paying with ${railLabel(r)}` : `Pay with ${railLabel(r)}`}
              </button>
            ))}
            {!primary ? <p className="text-ink-soft">No rail can serve this vendor. Check the route comparison.</p> : null}
          </div>
          <button type="button" className="btn btn-sm btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, "Cancelled before payment"))}>
            {busy === "reject" ? "Cancelling" : "Cancel"}
          </button>
          <p className="text-xs text-ink-soft">
            {p.selectedRail ? `${railLabel(p.selectedRail)} is the router's choice. ` : ""}
            Paying {formatMoney(p.amountMinor, p.currency)} moves the marker to paid, then to reconciled once the books record it.
          </p>
        </div>
      );
    }

    case "blocked":
      return <CorrectAmount id={p.id} amountMinor={p.amountMinor} currency={p.currency} blockedReason={p.blockedReason} pending={pending} busy={busy} run={run} />;

    case "failed":
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">The rail rejected the payment. Retry on the same rail, try the other, or cancel.</p>
          <div className="flex flex-wrap gap-2">
            {p.availableRails.map((r) => (
              <button key={r} type="button" className={`btn ${r === p.selectedRail ? "btn-primary" : ""}`} disabled={pending} onClick={() => pay(r)}>
                {busy === `pay-${r}` ? `Retrying with ${railLabel(r)}` : `Retry with ${railLabel(r)}`}
              </button>
            ))}
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, "Cancelled after failed payment"))}>
              {busy === "reject" ? "Cancelling" : "Cancel"}
            </button>
          </div>
        </div>
      );

    case "needs_evidence":
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">Policy is holding this until a job sheet, invoice or contract is attached. There is no evidence form on this page yet: re-create the obligation with the records attached and cancel this one.</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/obligations/new" className="btn">
              Re-create with evidence
            </Link>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, "No evidence supplied"))}>
              {busy === "reject" ? "Cancelling" : "Cancel"}
            </button>
          </div>
        </div>
      );

    case "sent":
    case "execution_pending":
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">The payment has been handed to {railLabel(p.selectedRail) || "the rail"}. Check for settlement to pull the latest status.</p>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => run("confirm", () => confirmAction(p.id), (r) => r.ok && travel(4))}>
            {busy === "confirm" ? "Checking" : "Check settlement"}
          </button>
        </div>
      );

    case "settled":
      return <p className="text-ink-soft">{p.hasAccounting ? "Paid and recorded. Nothing left to do." : "Paid. Waiting for the accounting record."}</p>;

    case "cancelled":
      return <p className="text-ink-soft">Cancelled. No money moved.</p>;

    default:
      return <p className="text-ink-soft">No actions available in this state.</p>;
  }
}

function CorrectAmount({ id, amountMinor, currency, blockedReason, pending, busy, run }: { id: string; amountMinor: number | null; currency: string | null; blockedReason: string | null; pending: boolean; busy: string | null; run: (label: string, fn: () => Promise<ActionResult>) => void }) {
  const evidenced = evidencedAmountFromReason(blockedReason);
  const [value, setValue] = useState(evidenced !== null ? (evidenced / 100).toFixed(2) : amountMinor !== null ? (amountMinor / 100).toFixed(2) : "");
  const duplicate = /already used/.test(blockedReason ?? "");
  const minor = value.trim() ? Math.round(Number(value.replace(/,/g, "")) * 100) : NaN;
  const valid = Number.isFinite(minor) && minor > 0 && minor !== amountMinor;

  return (
    <div className="space-y-3">
      {duplicate ? (
        <p className="text-ink-soft">This reference was already paid. If it is genuinely a second job, change the reference below; otherwise cancel it.</p>
      ) : (
        <p className="text-ink-soft">{evidenced !== null ? `The evidence says ${formatMoney(evidenced, currency)}. Correcting to that amount re-runs policy.` : "Correct the amount to what the evidence supports, then policy re-runs."}</p>
      )}
      {duplicate ? (
        <CorrectReference id={id} pending={pending} busy={busy} run={run} />
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) run("amend", () => amendAction(id, { amountMinor: minor }, `Corrected to evidenced amount ${formatMoney(minor, currency)}`));
          }}
        >
          <div>
            <label className="lbl" htmlFor="corrected-amount">
              Corrected amount ({currency ?? "USD"})
            </label>
            <input id="corrected-amount" className="field num w-40" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={pending || !valid}>
            {busy === "amend" ? "Correcting" : `Correct to ${Number.isFinite(minor) ? formatMoney(minor, currency) : "amount"}`}
          </button>
        </form>
      )}
      <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(id, duplicate ? "Duplicate of a paid obligation" : "Rejected after amount mismatch"))}>
        {busy === "reject" ? "Cancelling" : "Cancel obligation"}
      </button>
    </div>
  );
}

function CorrectReference({ id, pending, busy, run }: { id: string; pending: boolean; busy: string | null; run: (label: string, fn: () => Promise<ActionResult>) => void }) {
  const [ref, setRef] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ref.trim()) run("amend", () => amendAction(id, { sourceRef: ref.trim() }, "Reference corrected after duplicate check"));
      }}
    >
      <div>
        <label className="lbl" htmlFor="corrected-ref">
          New reference
        </label>
        <input id="corrected-ref" className="field num w-48" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="JOB-HG4D-0928" />
      </div>
      <button type="submit" className="btn" disabled={pending || !ref.trim()}>
        {busy === "amend" ? "Correcting" : "Correct reference"}
      </button>
    </form>
  );
}
