"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTeamAction } from "@/app/actions";
import { useToast } from "./Toast";

export type TeamRow = { username: string; displayName: string; role: string; roleLabel: string; approvalLimitMinor: number | null; delegateTo: string | null; delegateUntil: string | null; active: boolean; canApprove: boolean };

/** Who may do what. Roles come from the login configuration; limits, cover while away, and access are set here. */
export function TeamPanel({ rows, editable, symbol, me }: { rows: TeamRow[]; editable: boolean; symbol: string; me: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="dense border-b text-left text-ink-soft hairline">
            <th className="py-2 pr-3 font-normal">Person</th>
            <th className="py-2 pr-3 font-normal">Role</th>
            <th className="py-2 pr-3 font-normal">Approves up to</th>
            <th className="py-2 pr-3 font-normal">Away: covered by</th>
            <th className="py-2 pr-3 font-normal">Access</th>
            <th className="py-2 font-normal" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.username} r={r} rows={rows} editable={editable} symbol={symbol} me={me} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ r, rows, editable, symbol, me }: { r: TeamRow; rows: TeamRow[]; editable: boolean; symbol: string; me: string | null }) {
  const [limit, setLimit] = useState(r.approvalLimitMinor === null ? "" : String(r.approvalLimitMinor / 100));
  const [delegate, setDelegate] = useState(r.delegateTo ?? "");
  const [until, setUntil] = useState(r.delegateUntil ? r.delegateUntil.slice(0, 10) : "");
  const [active, setActive] = useState(r.active);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const isAdmin = r.role === "admin";
  const limitMinor = limit.trim() === "" ? null : Math.round(Number(limit.replace(/,/g, "")) * 100);
  const limitOk = limitMinor === null || (Number.isFinite(limitMinor) && limitMinor >= 0);
  const dirty =
    (!isAdmin && r.canApprove && limitMinor !== r.approvalLimitMinor) || delegate !== (r.delegateTo ?? "") || (delegate && until !== (r.delegateUntil ?? "").slice(0, 10)) || active !== r.active;
  const save = () =>
    start(async () => {
      const res = await updateTeamAction({
        username: r.username,
        ...(!isAdmin && r.canApprove && limitMinor !== r.approvalLimitMinor ? { approvalLimitMinor: limitMinor } : {}),
        ...(delegate !== (r.delegateTo ?? "") || (delegate && until !== (r.delegateUntil ?? "").slice(0, 10))
          ? { delegateTo: delegate || null, delegateUntil: delegate && until ? new Date(`${until}T23:59:59Z`).toISOString() : null }
          : {}),
        ...(active !== r.active ? { active } : {}),
      });
      toast(res.message, res.ok ? "ok" : "error");
      router.refresh();
    });
  return (
    <tr className="border-b align-top hairline">
      <td className="py-2 pr-3">
        {r.displayName}
        <span className="block text-xs text-ink-soft">
          {r.username}
          {me === r.username ? " (you)" : ""}
        </span>
      </td>
      <td className="py-2 pr-3">{r.roleLabel}</td>
      <td className="py-2 pr-3">
        {isAdmin ? (
          "No limit"
        ) : !r.canApprove ? (
          <span className="text-ink-soft">Does not approve</span>
        ) : editable ? (
          <label className="flex items-center gap-1">
            <span className="text-ink-soft">{symbol}</span>
            <input aria-label={`Approval limit for ${r.displayName}`} className="field num" style={{ width: "7rem" }} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="no limit" />
          </label>
        ) : (
          <span className="num">{r.approvalLimitMinor === null ? "No limit" : `${symbol}${(r.approvalLimitMinor / 100).toLocaleString("en-US")}`}</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {!r.canApprove ? (
          <span className="text-ink-soft">n/a</span>
        ) : editable ? (
          <div className="flex flex-wrap items-center gap-1">
            <select aria-label={`Who covers ${r.displayName}`} className="field" style={{ width: "8rem" }} value={delegate} onChange={(e) => setDelegate(e.target.value)}>
              <option value="">Nobody</option>
              {rows
                .filter((o) => o.username !== r.username && o.active)
                .map((o) => (
                  <option key={o.username} value={o.username}>
                    {o.displayName.split(" ")[0]}
                  </option>
                ))}
            </select>
            {delegate ? <input aria-label="Cover ends" type="date" className="field" style={{ width: "9.5rem" }} value={until} onChange={(e) => setUntil(e.target.value)} /> : null}
          </div>
        ) : r.delegateTo ? (
          `${r.delegateTo} until ${(r.delegateUntil ?? "").slice(0, 10)}`
        ) : (
          <span className="text-ink-soft">Nobody</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {editable && me !== r.username ? (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {active ? "Active" : "Off"}
          </label>
        ) : active ? (
          "Active"
        ) : (
          "Off"
        )}
      </td>
      <td className="py-2 text-right">
        {editable ? (
          <button type="button" className="btn btn-sm" disabled={pending || !dirty || !limitOk || (Boolean(delegate) && !until)} onClick={save}>
            {pending ? "Saving" : "Save"}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
