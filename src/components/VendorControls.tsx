"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInviteAction, rejectVendorChangeAction, setVendorStatusAction, verifyVendorChangeAction } from "@/app/actions";
import { useToast } from "./Toast";
import { CopyButton } from "./CopyButton";
import { formatDateTime } from "@/lib/format";

const METHODS: Array<[string, string]> = [
  ["callback", "Called them back on a number already on file"],
  ["penny_test", "Small test payment, amount confirmed by the vendor"],
  ["in_person", "Confirmed in person"],
  ["document", "Checked against a bank letter or statement"],
];

/** Make a single-use onboarding link and show it once. */
export function InviteLink({ vendorId }: { vendorId?: string }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  if (url)
    return (
      <div className="space-y-2">
        <p className="break-all rounded bg-paper p-2 text-xs num">{url}</p>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={url} label="Copy link" />
          <CopyButton value={`${url}?lang=vi`} label="Copy link (opens in Vietnamese)" />
        </div>
        <p className="text-xs text-ink-soft">Send it over a channel you already use with them. It is shown once; make a new one if it gets lost.</p>
      </div>
    );
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createInviteAction({ vendorId: vendorId ?? null, label: label || null });
          if (r.ok && r.path) setUrl(`${window.location.origin}${r.path}`);
          else toast(r.message, "error");
        });
      }}
    >
      {!vendorId ? (
        <div>
          <label className="lbl" htmlFor="invite-label">
            Who it is for (your note)
          </label>
          <input id="invite-label" className="field" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="New driver from Ha Giang" />
        </div>
      ) : null}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Making link" : vendorId ? "Send them a link to update details" : "Make an onboarding link"}
      </button>
    </form>
  );
}

export type ChangeView = {
  id: string;
  kind: string;
  warnings?: string[];
  source: string;
  requestedBy: string;
  createdAt: string;
  vendorName: string | null;
  lines: Array<[string, string, string | null]>; // label, proposed, current
  note: string | null;
};

/** A request waiting for a second person. Shows old against new, and asks how it was checked. */
export function PendingChange({ c, canVerify, mine }: { c: ChangeView; canVerify: boolean; mine: string | null }) {
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      toast(r.message, r.ok ? "ok" : "error");
      router.refresh();
    });
  const title = c.kind === "create" ? `New vendor from an onboarding link: ${c.vendorName ?? "unnamed"}` : c.kind === "initial" ? "Details entered when the vendor was added" : `New payout details for ${c.vendorName ?? "this vendor"}`;
  return (
    <div className="space-y-3">
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-ink-soft">
          Asked by {c.requestedBy.replace(/^user:/, "").replace(/^vendor:onboarding:.*/, "the vendor, through their link")} on {formatDateTime(c.createdAt)}
          {c.note ? `: ${c.note}` : ""}
        </p>
      </div>
      {c.warnings?.length ? (
        <ul className="space-y-1 rounded bg-attention-soft px-3 py-2 text-sm text-attention">
          {c.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="dense text-left text-ink-soft">
            <th className="py-1 pr-3 font-normal">
              <span className="sr-only">Detail</span>
            </th>
            <th className="py-1 pr-3 font-normal">Proposed</th>
            {c.kind === "payout" ? <th className="py-1 font-normal">On file now</th> : null}
          </tr>
        </thead>
        <tbody>
          {c.lines.map(([label, proposed, current]) => (
            <tr key={label} className="border-t align-top hairline">
              <td className="py-1 pr-3 text-ink-soft">{label}</td>
              <td className={`num py-1 pr-3 break-all ${c.kind === "payout" && proposed !== (current ?? "") ? "font-medium text-attention" : ""}`}>
                {proposed || "none"}
                {/* A word as well as amber, so a changed value is not told by colour alone. */}
                {c.kind === "payout" && proposed !== (current ?? "") ? <span className="dense ml-2 inline-block whitespace-nowrap rounded-sm px-1.5 font-sans" style={{ background: "var(--attention-soft)" }}>Changed</span> : null}
              </td>
              {c.kind === "payout" ? <td className="num py-1 break-all text-ink-soft">{current || "none"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {canVerify && !mine ? (
        <div className="space-y-2 border-t pt-3 hairline">
          <p className="text-xs text-ink-soft">Check with the vendor through a contact you already had, not one in this request. A changed-details email is the most common way businesses are robbed.</p>
          <div>
            <label className="lbl" htmlFor={`m-${c.id}`}>
              How you checked
            </label>
            <select id={`m-${c.id}`} className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">Choose</option>
              {METHODS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <input aria-label="Note" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Who you spoke to, and on which number or address" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={pending || !method} onClick={() => run(() => verifyVendorChangeAction(c.id, method, note || undefined))}>
              {pending ? "Saving" : "Verified, use these details"}
            </button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => run(() => rejectVendorChangeAction(c.id, note || undefined))}>
              Turn down
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-ink-soft">{mine ? mine : "An approver or the owner verifies this."}</p>
      )}
    </div>
  );
}

export function BlockToggle({ vendorId, status }: { vendorId: string; status: string }) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const blocked = status === "blocked";
  if (!open)
    return (
      <button type="button" className={`btn btn-sm ${blocked ? "" : "btn-danger"}`} onClick={() => setOpen(true)}>
        {blocked ? "Unblock" : "Block payments"}
      </button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setVendorStatusAction(vendorId, blocked ? "active" : "blocked", reason);
          toast(r.message, r.ok ? "ok" : "error");
          if (r.ok) setOpen(false);
          router.refresh();
        });
      }}
    >
      <input aria-label="Reason" className="field w-56" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={blocked ? "Dispute settled" : "Suspected fraud, investigating"} required />
      <button type="submit" className={`btn btn-sm ${blocked ? "" : "btn-danger"}`} disabled={pending || !reason.trim()}>
        {blocked ? "Unblock" : "Block"}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
        Never mind
      </button>
    </form>
  );
}
