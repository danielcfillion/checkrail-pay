"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cancelReleaseAction, tickAutopilotAction } from "@/app/actions";
import { useToast } from "./Toast";

export type ScheduledRow = { id: string; vendorName: string | null; amountText: string; releaseAt: string };

function left(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / 1000));
  if (s === 0) return "sending";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Payments autopilot has scheduled, each with a live countdown and a cancel button. */
export function ScheduledReleases({ rows, compact = false }: { rows: ScheduledRow[]; compact?: boolean }) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const fired = useRef<Set<string>>(new Set());
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // When a window ends, ask for a pass now so the screen does not wait for the next heartbeat.
  useEffect(() => {
    if (nowMs === null) return;
    const due = rows.filter((r) => new Date(r.releaseAt).getTime() <= nowMs && !fired.current.has(r.id));
    if (!due.length) return;
    due.forEach((r) => fired.current.add(r.id));
    start(async () => {
      const r = await tickAutopilotAction();
      if (r.ok && r.message !== "Nothing was due.") toast(r.message, "ok");
      router.refresh();
    });
  }, [nowMs, rows, router, toast]);

  if (!rows.length) return null;
  return (
    <ul className="divide-y hairline">
      {rows.map((r) => (
        <li key={r.id} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 ${compact ? "py-2" : "px-4 py-2.5"}`}>
          <Link href={`/obligations/${r.id}`} className="min-w-0 hover:underline">
            <span className="font-medium">{r.vendorName ?? "Unknown vendor"}</span> <span className="num text-ink-soft">{r.amountText}</span>
          </Link>
          <span className="flex items-center gap-3">
            <span className="num text-ink-soft" aria-live="off">
              {nowMs === null ? "scheduled" : left(r.releaseAt, nowMs) === "sending" ? "sending now" : `sends in ${left(r.releaseAt, nowMs)}`}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
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
          </span>
        </li>
      ))}
    </ul>
  );
}
