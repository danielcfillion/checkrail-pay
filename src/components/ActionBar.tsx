"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { amendAction, approveAction, confirmAction, markReturnedAction, recheckAction, repayAction, requoteAction, executeAction, reconcileAction, rejectAction, resolveManuallyAction, retryFailedAction, type ActionResult } from "@/app/actions";
import type { Rail } from "@/lib/domain/types";
import { evidencedAmountFromReason, formatMoney, railLabel } from "@/lib/format";
import { isDuplicateReason } from "./decision-model";
import { SUMMARY, TOUCH_SM } from "./RequestPanels";
import { useToast } from "./Toast";
import { useStage } from "./ObligationStage";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

type Props = {
  id: string;
  /** Fingerprints of the warnings this page rendered. Approving sends them, so an approval covers what this person saw. */
  shownWarnings?: string[];
  /** Idempotency key of the attempt whose outcome is unclear: what to search for in the provider dashboard. */
  pendingKey?: string | null;
  state: string;
  amountMinor: number | null;
  currency: string | null;
  blockedReason: string | null;
  selectedRail: string | null;
  availableRails: Rail[];
  hasAccounting: boolean;
  /** What the viewer may do. The server checks again; this only hides buttons that would be refused. */
  perms?: { approve: boolean; pay: boolean; amend: boolean; resolveStuck: boolean; reconcile?: boolean };
  /** Why this viewer cannot approve this one (role, limit, or they prepared it), when they cannot. */
  approveRefusal?: string | null;
  vendorId?: string | null;
  billId?: string | null;
  /** Vendors to pick from when the request names nobody the business knows. */
  vendorChoices?: Array<{ id: string; name: string }>;
  /** The decision card above already offers the primary action to this viewer, so this panel leaves it out. */
  primaryInCard?: boolean;
};

const ALL = { approve: true, pay: true, amend: true, resolveStuck: true, reconcile: true };

function Waiting({ children }: { children: React.ReactNode }) {
  return <p className="rounded border px-3 py-2 text-ink-soft hairline">{children}</p>;
}

/**
 * The actions a person can take, by state. Each button names the action.
 * On a successful payment the check line marker travels to paid, then reconciled.
 */
export function ActionBar(p: Props) {
  const can: typeof ALL = { ...ALL, ...(p.perms ?? {}), reconcile: p.perms ? Boolean(p.perms.reconcile) : true };
  const [pending, start] = useTransition();
  const { travel, note: approvalNote, setNote: setApprovalNote } = useStage();
  const [batchId, setBatchId] = useState("");
  const [returnedId, setReturnedId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();
  const { toast } = useToast();
  const lead = "btn btn-primary";
  const inCard = Boolean(p.primaryInCard);

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
          {can.approve && !p.approveRefusal ? (
            <>
              <div>
                <label className="lbl" htmlFor="approval-note">
                  Note (optional)
                </label>
                <input id="approval-note" className="field" value={approvalNote} onChange={(e) => setApprovalNote(e.target.value)} placeholder="Checked against the trip sheet" />
              </div>
              <div className="flex flex-wrap gap-2">
                {inCard ? null : (
                  <button type="button" className={lead} disabled={pending} onClick={() => run("approve", () => approveAction(p.id, approvalNote.trim() || undefined, p.shownWarnings))}>
                    {busy === "approve" ? "Approving" : "Approve"}
                  </button>
                )}
                <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, approvalNote.trim() || undefined))}>
                  {busy === "reject" ? "Rejecting" : "Reject"}
                </button>
              </div>
              <p className="text-xs text-ink-soft">{inCard ? "Add a note before Approve or Reject. " : ""}Approving does not pay. Policy checks again, then the request is ready to pay.</p>
            </>
          ) : (
            <>
              <Waiting>{p.approveRefusal ?? "Waiting for an approver. Your role does not approve payments."}</Waiting>
              {can.approve ? (
                <button type="button" className={`btn btn-sm btn-danger ${TOUCH_SM}`} disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, "Turned down"))}>
                  {busy === "reject" ? "Rejecting" : "Reject"}
                </button>
              ) : null}
            </>
          )}
          {can.amend ? <AmendDetails id={p.id} amountMinor={p.amountMinor} currency={p.currency} pending={pending} busy={busy} run={run} /> : null}
        </div>
      );

    case "approved": {
      const primary = (p.selectedRail as Rail | null) ?? p.availableRails[0] ?? null;
      const others = p.availableRails.filter((r) => r !== primary);
      return (
        <div className="space-y-3">
          {can.pay ? (
            <div className="flex flex-wrap gap-2">
              {primary && !inCard ? (
                <button type="button" className={lead} disabled={pending} onClick={() => pay(primary)}>
                  {busy === `pay-${primary}` ? `Paying with ${railLabel(primary)}` : `Pay with ${railLabel(primary)}`}
                </button>
              ) : null}
              {others.map((r) => (
                <button key={r} type="button" className="btn" disabled={pending} onClick={() => pay(r)}>
                  {busy === `pay-${r}` ? `Paying with ${railLabel(r)}` : `Pay with ${railLabel(r)}`}
                </button>
              ))}
              {!primary ? <p className="text-ink-soft">No rail can serve this vendor. Check the route comparison.</p> : null}
              <button type="button" className={`btn btn-sm ${TOUCH_SM}`} disabled={pending} onClick={() => run("requote", () => requoteAction(p.id))}>
                {busy === "requote" ? "Quoting" : "Quote again"}
              </button>
            </div>
          ) : (
            <Waiting>Approved and ready to send. Someone who sends payments sends it.</Waiting>
          )}
          {can.approve ? (
            <button type="button" className={`btn btn-sm btn-danger ${TOUCH_SM}`} disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, "Cancelled before payment"))}>
              {busy === "reject" ? "Cancelling" : "Cancel request"}
            </button>
          ) : null}
          {can.pay ? (
            <p className="text-xs text-ink-soft">
              {p.selectedRail ? `${railLabel(p.selectedRail)} is the router's choice. ` : ""}
              Paying {formatMoney(p.amountMinor, p.currency)} moves the marker to paid, then to reconciled once the books record it.
            </p>
          ) : null}
          {can.amend ? <AmendDetails id={p.id} amountMinor={p.amountMinor} currency={p.currency} pending={pending} busy={busy} run={run} note="Changing the amount sends it back for approval." /> : null}
        </div>
      );
    }

    case "blocked":
      if (!can.amend) return <Waiting>Blocked: {p.blockedReason ?? "a check failed"}. A clerk or the owner fixes the request or cancels it.</Waiting>;
      if (!p.vendorId && /not a known vendor/i.test(p.blockedReason ?? "")) return <PickVendor id={p.id} choices={p.vendorChoices ?? []} pending={pending} busy={busy} run={run} />;
      return (
        <div className="space-y-3">
          <CorrectAmount id={p.id} amountMinor={p.amountMinor} currency={p.currency} blockedReason={p.blockedReason} pending={pending} busy={busy} run={run} lead={lead} inCard={inCard} />
          <CheckAgain id={p.id} pending={pending} busy={busy} run={run} />
        </div>
      );

    case "failed":
      if (!can.pay) return <Waiting>The rail rejected this payment and nothing moved. Someone who sends payments retries or cancels it.</Waiting>;
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">The rail rejected the payment and nothing moved. Retry on the same rail, try the other, or cancel. A retry re-checks the payout destination and runs policy again before any rail is called.</p>
          <div className="flex flex-wrap gap-2">
            {p.availableRails.filter((r) => !(inCard && r === p.selectedRail)).map((r) => (
              <button
                key={r}
                type="button"
                className={`btn ${r === p.selectedRail ? "btn-primary" : ""}`}
                disabled={pending}
                onClick={() =>
                  run(`pay-${r}`, async () => {
                    const back = await retryFailedAction(p.id);
                    if (!back.ok) return back;
                    return executeAction(p.id, r);
                  }, (res) => res.ok && travel(3))
                }
              >
                {busy === `pay-${r}` ? `Retrying with ${railLabel(r)}` : `Retry with ${railLabel(r)}`}
              </button>
            ))}
            {can.amend ? (
              <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, "Cancelled after failed payment"))}>
                {busy === "reject" ? "Cancelling" : "Cancel request"}
              </button>
            ) : null}
          </div>
        </div>
      );

    case "needs_evidence":
      if (!can.amend) return <Waiting>Held until a job sheet, invoice or contract is attached. A clerk or the owner adds it.</Waiting>;
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">Policy is holding this until a job sheet, invoice or contract is attached. Ask the vendor for it with the link below (their upload is read and checked like any record), or re-create the request with the records attached and cancel this one.</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/obligations/new" className="btn">
              Re-create with evidence
            </Link>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(p.id, "No evidence supplied"))}>
              {busy === "reject" ? "Cancelling" : "Cancel request"}
            </button>
          </div>
          <CheckAgain id={p.id} pending={pending} busy={busy} run={run} />
        </div>
      );

    case "execution_pending":
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">
            {railLabel(p.selectedRail) || "The rail"} did not give a clear answer, so this payment may or may not have gone through. Nothing here will pay it again: Reconcile asks {railLabel(p.selectedRail) || "the rail"} about the same payment under the same idempotency key and records what it finds.
          </p>
          {can.pay && !inCard ? (
            <button type="button" className={lead} disabled={pending} onClick={() => run("reconcile", () => reconcileAction(p.id), (r) => r.ok && travel(3))}>
              {busy === "reconcile" ? "Asking the rail" : `Reconcile with ${railLabel(p.selectedRail) || "the rail"}`}
            </button>
          ) : null}
          {can.resolveStuck ? (
          <details className="text-sm">
            <summary className={SUMMARY}>Still unclear? Resolve it from the {railLabel(p.selectedRail) || "provider"} dashboard</summary>
            <div className="mt-3 space-y-3">
              <p className="text-ink-soft">Search the dashboard for this attempt&apos;s sender batch id. Both choices are recorded in the audit log under your name.</p>
              {p.pendingKey ? (
                <p className="flex flex-wrap items-center gap-2">
                  <code className="num break-all text-xs">{p.pendingKey}</code>
                  <CopyButton value={p.pendingKey} label="Copy sender batch id" />
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <input className="field w-56" placeholder="Payout batch id" value={batchId} onChange={(e) => setBatchId(e.target.value)} aria-label="Payout batch id found in the dashboard" />
                <button type="button" className="btn" disabled={pending || batchId.trim().length < 6} onClick={() => run("found", () => resolveManuallyAction(p.id, batchId.trim()))}>
                  {busy === "found" ? "Recording" : "I found it: record this id"}
                </button>
              </div>
              <ConfirmButton
                label="I checked: nothing was paid"
                busyLabel="Recording"
                tone="danger"
                confirmText="This marks the attempt failed, which allows a new payment under a fresh key. Only confirm if the dashboard shows no batch with the id above."
                action={() => resolveManuallyAction(p.id, null)}
              />
            </div>
          </details>
          ) : null}
        </div>
      );

    case "sent":
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">The payment has been handed to {railLabel(p.selectedRail) || "the rail"}. {inCard ? "Check settlement above pulls the latest status." : "Check for settlement to pull the latest status."}</p>
          {inCard ? null : (
            <button type="button" className={lead} disabled={pending} onClick={() => run("confirm", () => confirmAction(p.id), (r) => r.ok && travel(4))}>
              {busy === "confirm" ? "Checking" : "Check settlement"}
            </button>
          )}
        </div>
      );

    case "settled":
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">{p.hasAccounting ? "Paid and recorded. Nothing left to do." : "Paid. Waiting for the accounting record."}</p>
          {can.reconcile ? (
            <details className="text-sm">
              <summary className={SUMMARY}>The money came back (found in PayPal)?</summary>
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (returnedId.trim()) run("returned", () => markReturnedAction(p.id, returnedId.trim()));
                }}
              >
                <input className="field num w-56" value={returnedId} onChange={(e) => setReturnedId(e.target.value)} placeholder="PayPal transaction id" aria-label="PayPal transaction id of the money that came back" />
                <button type="submit" className={`btn btn-sm btn-danger ${TOUCH_SM}`} disabled={pending || returnedId.trim().length < 6}>
                  {busy === "returned" ? "Recording" : "Record it as come back"}
                </button>
              </form>
            </details>
          ) : null}
        </div>
      );

    case "refunded":
      return (
        <div className="space-y-3">
          <p className="text-ink-soft">The money came back to the business (an unclaimed or reversed payout), so the vendor is owed again. Check their payout details with them first; an unclaimed payout often means the address is wrong.</p>
          {p.billId ? (
            <p className="text-ink-soft">This was part of a bill: pay what is open on it from the vendor&apos;s page.</p>
          ) : can.amend ? (
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => run("repay", () => repayAction(p.id), (r) => { if (r.ok && (r as { id?: string }).id) window.location.href = `/obligations/${(r as { id?: string }).id}`; })}>
              {busy === "repay" ? "Requesting" : "Pay it again"}
            </button>
          ) : null}
        </div>
      );

    case "cancelled":
      return <p className="text-ink-soft">Cancelled. No money moved.</p>;

    default:
      return <p className="text-ink-soft">No actions available in this state.</p>;
  }
}

function CorrectAmount({ id, amountMinor, currency, blockedReason, pending, busy, run, lead = "btn btn-primary", inCard = false }: { id: string; amountMinor: number | null; currency: string | null; blockedReason: string | null; pending: boolean; busy: string | null; run: (label: string, fn: () => Promise<ActionResult>) => void; lead?: string; inCard?: boolean }) {
  const evidenced = evidencedAmountFromReason(blockedReason);
  // The card above already offers the evidenced figure, so the field here starts empty: it is for a different amount.
  const [value, setValue] = useState(inCard ? "" : evidenced !== null ? (evidenced / 100).toFixed(2) : amountMinor !== null ? (amountMinor / 100).toFixed(2) : "");
  // Every duplicate (same reference, same job under a new reference, or paid in PayPal's own records) is fixed the same
  // way: a genuinely different job gets its own reference, anything else is cancelled. The amount is not the problem.
  const duplicate = isDuplicateReason(blockedReason);
  const paypal = /^PayPal transaction/.test(blockedReason ?? "");
  const rateCard = /^Rate card/.test(blockedReason ?? "");
  const minor = value.trim() ? Math.round(Number(value.replace(/,/g, "")) * 100) : NaN;
  const valid = Number.isFinite(minor) && minor > 0 && minor !== amountMinor;
  const cancel = (
    <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(id, duplicate ? "Duplicate of a paid request" : "Rejected after amount mismatch"))}>
      {busy === "reject" ? "Cancelling" : "Cancel request"}
    </button>
  );

  if (duplicate)
    return (
      <div className="space-y-3">
        <p className="text-ink-soft">
          {paypal ? "PayPal's own records show this job already paid to this payee." : "This job was already paid."} If it is genuinely a second job, give it its own reference below and policy checks it again. {inCard ? "Otherwise cancel it above." : "Otherwise cancel it."}
        </p>
        <CorrectReference id={id} pending={pending} busy={busy} run={run} />
        {inCard ? null : cancel}
      </div>
    );

  const form = (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) run("amend", () => amendAction(id, { amountMinor: minor }, rateCard && minor === evidenced ? `Short pay to the rate card: ${formatMoney(minor, currency)}` : `Corrected to evidenced amount ${formatMoney(minor, currency)}`));
      }}
    >
      <div>
        <label className="lbl" htmlFor="corrected-amount">
          {inCard ? "A different amount" : "Corrected amount"} ({currency ?? "USD"})
        </label>
        <input id="corrected-amount" className="field num w-40" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={inCard && evidenced !== null ? (evidenced / 100).toFixed(2) : undefined} />
      </div>
      <button type="submit" className={inCard ? "btn" : lead} disabled={pending || !valid}>
        {busy === "amend" ? "Correcting" : inCard ? "Correct and re-check" : `Correct to ${Number.isFinite(minor) ? formatMoney(minor, currency) : "amount"}`}
      </button>
    </form>
  );

  return (
    <div className="space-y-3">
      {inCard ? (
        <p className="text-ink-soft">
          {rateCard && evidenced !== null
            ? `Correcting to the rate card (${formatMoney(evidenced, currency)}) is a short pay: a person approves it, and the vendor should be told why the rest is not paid.`
            : "The correction above re-runs policy. If the evidence is wrong instead, correct to a different amount here."}
        </p>
      ) : (
        <p className="text-ink-soft">
          {rateCard && evidenced !== null
            ? `The rate card says ${formatMoney(evidenced, currency)}. Paying that is a short pay: a person approves it, and the vendor should be told why the rest is not paid (or send a revised invoice with the link below).`
            : evidenced !== null
              ? `The evidence says ${formatMoney(evidenced, currency)}. Correcting to that amount re-runs policy.`
              : "Correct the amount to what the evidence supports, then policy re-runs."}
        </p>
      )}
      {form}
      {cancel}
    </div>
  );
}

/** For a block whose cause was fixed elsewhere: the vendor was verified, a rate card or departure was added. */
function CheckAgain({ id, pending, busy, run }: { id: string; pending: boolean; busy: string | null; run: (label: string, fn: () => Promise<ActionResult>) => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-ink-soft hairline">
      Fixed the cause somewhere else (verified the vendor, added a rate or departure)?
      <button type="button" className={`btn btn-sm ${TOUCH_SM}`} disabled={pending} onClick={() => run("recheck", () => recheckAction(id))}>
        {busy === "recheck" ? "Checking" : "Check again"}
      </button>
    </p>
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

/** A correction tucked away on screens where the usual next step is approve or pay. */
function AmendDetails({ id, amountMinor, currency, pending, busy, run, note }: { id: string; amountMinor: number | null; currency: string | null; pending: boolean; busy: string | null; run: (label: string, fn: () => Promise<ActionResult>) => void; note?: string }) {
  const [value, setValue] = useState(amountMinor !== null ? (amountMinor / 100).toFixed(2) : "");
  const minor = value.trim() ? Math.round(Number(value.replace(/,/g, "")) * 100) : NaN;
  const valid = Number.isFinite(minor) && minor > 0 && minor !== amountMinor;
  return (
    <details className="border-t pt-3 text-sm hairline">
      <summary className={SUMMARY}>Correct the amount</summary>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) run("amend", () => amendAction(id, { amountMinor: minor }, `Amount corrected to ${formatMoney(minor, currency)}`));
        }}
      >
        <div>
          <label className="lbl" htmlFor="amend-amount">
            Amount ({currency ?? "USD"})
          </label>
          <input id="amend-amount" className="field num w-40" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <button type="submit" className="btn" disabled={pending || !valid}>
          {busy === "amend" ? "Correcting" : "Correct and re-check"}
        </button>
      </form>
      <p className="mt-2 text-xs text-ink-soft">{note ?? "Any approval already given no longer counts; policy runs again on the new amount."}</p>
    </details>
  );
}

/** The request names someone the business does not pay yet: attach it to a vendor on file, or add the vendor first. */
function PickVendor({ id, choices, pending, busy, run }: { id: string; choices: Array<{ id: string; name: string }>; pending: boolean; busy: string | null; run: (label: string, fn: () => Promise<ActionResult>) => void }) {
  const [vendorId, setVendorId] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-ink-soft">Nobody on file matches this payee. If it is a vendor you already pay under another name, pick them; policy then runs again. If it is someone new, add them as a vendor first, so their payout details are verified before any money goes to them.</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (vendorId) run("amend", () => amendAction(id, { vendorId }, "Payee matched to a vendor on file"));
        }}
      >
        <div>
          <label className="lbl" htmlFor="pick-vendor">
            Vendor on file
          </label>
          <select id="pick-vendor" className="field w-64" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Choose a vendor</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={pending || !vendorId}>
          {busy === "amend" ? "Matching" : "Use this vendor"}
        </button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Link href="/vendors/new" className="btn">
          Add a new vendor
        </Link>
        <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run("reject", () => rejectAction(id, "Payee is not a known vendor"))}>
          {busy === "reject" ? "Cancelling" : "Cancel request"}
        </button>
      </div>
    </div>
  );
}
