"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cancelReleaseAction, tickAutopilotAction } from "@/app/actions";
import { formatMoney, railLabel, timeAgo } from "@/lib/format";
import { useToast } from "./Toast";

/** `concern` is what the request page says about its reading when that is not clear (see readerNotesFor); null when clear. */
export type ScheduledRow = { id: string; vendorName: string | null; amountText: string; releaseAt: string; concern?: { chip: string; line: string } | null };
export type ReleasedRow = { id: string; vendorName: string | null; amountMinor: number | null; currency: string | null; rail: string | null; state: string; at: string };

/** How long a payment the agent sent stays on screen in settled style. */
export const KEEP_RELEASED_MS = 120_000;

function secondsLeft(iso: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / 1000));
}

function clock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function sentLine(r: ReleasedRow, nowMs: number | null): string {
  const when = nowMs === null ? "just now" : timeAgo(r.at, nowMs);
  const rail = r.rail ? railLabel(r.rail) : "the rail";
  const how = r.state === "settled" ? `settled over ${rail}` : r.state === "sent" ? `sent over ${rail}, confirming` : `sending over ${rail}`;
  return `Sent by autopilot ${when}: ${r.vendorName ?? "Unknown vendor"} ${formatMoney(r.amountMinor, r.currency)}, ${how}.`;
}

/**
 * Payments autopilot has scheduled, each with a large countdown, a bar that drains over the cancel window and a
 * Cancel button; then, for two minutes, what the agent just sent (DS2-9). When a refresh finds that a payment this
 * page had listed as scheduled has gone out, it says so in a toast, whoever sent it: the server heartbeat often
 * releases before this page's own timer runs out.
 */
export function ScheduledReleases({ rows, released = [], windowSeconds = 0, compact = false, canCancel = true, className = "" }: { rows: ScheduledRow[]; released?: ReleasedRow[]; windowSeconds?: number; compact?: boolean; canCancel?: boolean; className?: string }) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const fired = useRef<Set<string>>(new Set());
  const listed = useRef<Set<string>>(new Set());
  const toasted = useRef<Set<string>>(new Set());
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Remember what was on screen as scheduled; announce each one once when it shows up as sent.
  useEffect(() => {
    for (const r of released) {
      if (listed.current.has(r.id) && !toasted.current.has(r.id)) {
        toasted.current.add(r.id);
        toast(`Autopilot sent ${formatMoney(r.amountMinor, r.currency)} to ${r.vendorName ?? "the vendor"}.`, "ok");
      }
    }
    for (const r of rows) listed.current.add(r.id);
  }, [rows, released, toast]);

  // When a window ends, ask for a pass now so the screen does not wait for the next heartbeat.
  useEffect(() => {
    if (nowMs === null) return;
    const due = rows.filter((r) => new Date(r.releaseAt).getTime() <= nowMs && !fired.current.has(r.id));
    if (!due.length) return;
    due.forEach((r) => fired.current.add(r.id));
    start(async () => {
      const r = await tickAutopilotAction();
      if (!r.ok) toast(r.message, "error");
      router.refresh();
    });
  }, [nowMs, rows, router, toast]);

  // A just-sent payment needs one more refresh to show it settled.
  useEffect(() => {
    if (!released.some((r) => r.state !== "settled")) return;
    const t = setTimeout(() => router.refresh(), 3000);
    return () => clearTimeout(t);
  }, [released, router]);

  const recent = released.filter((r) => nowMs === null || nowMs - new Date(r.at).getTime() < KEEP_RELEASED_MS);
  if (!rows.length && !recent.length) return null;
  const pad = compact ? "px-4 py-2.5" : "px-4 py-3";
  return (
    <ul className={`divide-y hairline ${className}`}>
      {rows.map((r) => {
        const s = nowMs === null ? null : secondsLeft(r.releaseAt, nowMs);
        const pct = s === null || windowSeconds <= 0 ? 100 : Math.max(0, Math.min(100, (s / windowSeconds) * 100));
        return (
          <li key={r.id} className={pad}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <Link href={`/obligations/${r.id}`} className="hover:underline">
                  <span className="font-medium">{r.vendorName ?? "Unknown vendor"}</span> <span className="num whitespace-nowrap">{r.amountText}</span>
                </Link>
                {r.concern ? (
                  <>
                    {" "}
                    <span className="dense inline-block whitespace-nowrap rounded-sm px-1.5 text-attention" style={{ boxShadow: "inset 0 0 0 1px var(--attention)" }}>
                      {r.concern.chip}
                    </span>
                    <p className="text-xs text-attention">{r.concern.line}</p>
                  </>
                ) : null}
                <p className="text-xs text-ink-soft">Autopilot sends it when the timer runs out. Cancel keeps it for a person.</p>
              </div>
              <div className="flex items-center gap-3">
                <p className="text-right" aria-live="off">
                  <span className="dense block text-ink-soft">{s === 0 ? "sending now" : "sends in"}</span>
                  <span className="wide num block text-xl text-attention">{s === null ? "scheduled" : clock(s)}</span>
                </p>
                {canCancel ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={pending || s === 0}
                    onClick={() =>
                      start(async () => {
                        const res = await cancelReleaseAction(r.id);
                        toast(res.message, res.ok ? "ok" : "error");
                        router.refresh();
                      })
                    }
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--rule)" }} aria-hidden>
              <div className="release-bar h-1 rounded-full" style={{ width: `${pct}%`, background: "var(--attention)" }} />
            </div>
          </li>
        );
      })}
      {recent.map((r) => (
        <li key={`sent-${r.id}`} className={`${pad} bg-settled-soft`} style={{ boxShadow: "inset 3px 0 0 var(--settled)" }}>
          <Link href={`/obligations/${r.id}`} className="flex items-start gap-2 text-settled hover:underline">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
            <span className="font-medium">{sentLine(r, nowMs)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
