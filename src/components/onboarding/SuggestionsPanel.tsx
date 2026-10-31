"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { applySuggestionAction, dismissSuggestionAction } from "@/app/onboarding/actions";
import { useToast } from "@/components/Toast";
import { TonePill } from "@/components/ui";
import { currencyDecimals, formatDateTime, humaniseActor, pluralise } from "@/lib/format";
import type { SuggestionRow } from "@/lib/onboarding/dashboard";
import { applyEffect, decisionPermission, screenLabel, whoDecides } from "./calibrate-model";

/* .btn is plain CSS outside Tailwind's layers, so a utility class cannot restyle it: these go inline. */
const STRONG = { fontWeight: 600 } as const;
const GHOST = { borderColor: "transparent", color: "var(--ink-soft)" } as const;

/**
 * What the marks suggest. Each suggestion says what applying it does before anyone presses Apply; nothing changes until
 * a person applies one, and only a rate card changes anything here (through the same check as the supplier page).
 */
export function SuggestionsPanel({ rows, can }: { rows: SuggestionRow[]; can: { verify_vendor: boolean; settings: boolean } }) {
  const proposed = rows.filter((s) => s.status === "proposed");
  const decided = rows.filter((s) => s.status !== "proposed");
  return (
    <section aria-labelledby="suggest-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="suggest-title" className="text-lg font-semibold">
          What your marks suggest
        </h2>
        <p className="dense text-ink-soft">{proposed.length ? pluralise(proposed.length, "suggestion") + " to decide" : "nothing to decide"}</p>
      </div>
      <p className="mt-1 max-w-3xl text-ink-soft">Marks never change a rule on their own. A suggestion changes nothing until a person applies it, and every decision is kept in the audit log.</p>

      {proposed.length ? (
        <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {proposed.map((s) => (
            <Suggestion key={s.suggestion_id} s={s} allowed={can[decisionPermission(s.kind)]} />
          ))}
        </ul>
      ) : (
        <div className="panel mt-4 px-6 py-6 text-ink-soft">No suggestions yet. They appear as you mark calls &quot;Was fine&quot;: a supplier held again and again points to a missing rate card or booking record.</div>
      )}

      {decided.length ? (
        <details className="mt-4" open>
          <summary>Decided ({decided.length})</summary>
          <ul className="panel mt-2 divide-y hairline">
            {decided.map((s) => (
              <li key={s.suggestion_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                <TonePill tone={s.status === "applied" ? "settled" : "muted"}>{s.status === "applied" ? "Applied" : "Dismissed"}</TonePill>
                <span className="min-w-0 flex-1 font-medium">{s.title}</span>
                <span className="dense text-ink-soft">
                  {s.decided_by ? `by ${humaniseActor(s.decided_by)}` : ""}
                  {s.decided_at ? `, ${formatDateTime(s.decided_at)}` : ""}
                </span>
                {s.status === "applied" && s.screen ? (
                  <Link href={s.screen} className="link dense">
                    {screenLabel(s.screen)}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Suggestion({ s, allowed }: { s: SuggestionRow; allowed: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [busy, setBusy] = useState<"apply" | "dismiss" | null>(null);
  const [, startRefresh] = useTransition();
  const decimals = currencyDecimals(s.proposed_currency);
  const [rate, setRate] = useState(s.proposed_rate_minor !== null ? (s.proposed_rate_minor / 100).toFixed(decimals) : "");

  const typed = s.kind === "rate_card" && rate.trim() ? Math.round(Number(rate.replace(/,/g, "")) * 100) : null;
  const rateOk = typed === null || (Number.isFinite(typed) && typed > 0);

  const apply = async () => {
    if (!rateOk) return toast("Enter the rate as a number above zero.", "error");
    setBusy("apply");
    const input: Parameters<typeof applySuggestionAction>[1] = typed !== null ? { rate: { rateMinor: typed } } : undefined;
    const res = await applySuggestionAction(s.suggestion_id, input);
    setBusy(null);
    if (!res.ok) return toast(res.message, "error");
    toast(res.message);
    startRefresh(() => router.refresh());
  };
  const dismiss = async () => {
    setBusy("dismiss");
    const res = await dismissSuggestionAction(s.suggestion_id);
    setBusy(null);
    if (!res.ok) return toast(res.message, "error");
    toast(res.message);
    startRefresh(() => router.refresh());
  };

  return (
    <li className="panel flex min-w-0 flex-col px-5 py-5">
      <p className="dense text-ink-soft">{s.kind_label}</p>
      <h3 className="mt-1 text-base font-semibold">{s.title}</h3>
      <p className="mt-1.5 text-ink-soft">{s.detail}</p>
      <p className="mt-3 rounded-xl bg-paper px-3 py-2.5">
        <span className="font-medium">If you apply: </span>
        {applyEffect(s, rateOk && typed !== null ? typed : s.proposed_rate_minor)}
      </p>
      <p className="dense mt-2 text-ink-soft">
        Rests on {pluralise(s.basis_count, "marked call")}.
        {s.screen ? (
          <>
            {" "}
            <Link href={s.screen} className="link">
              {screenLabel(s.screen)}
            </Link>
          </>
        ) : null}
      </p>
      {allowed && s.kind === "rate_card" && s.proposed_currency ? (
        <details className="mt-2">
          <summary>Change the rate first</summary>
          <div className="mt-2 max-w-[220px]">
            <label className="lbl" htmlFor={`${id}-rate`}>
              Rate in {s.proposed_currency}, a {(s.proposed_unit ?? "trip").replace(/_/g, "-")}
            </label>
            <input id={`${id}-rate`} className="field num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
        </details>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {allowed ? (
          <>
            <button type="button" className="btn btn-sm" style={STRONG} disabled={busy !== null || !rateOk} onClick={apply}>
              {busy === "apply" ? "Applying" : "Apply"}
            </button>
            <button type="button" className="btn btn-sm" style={GHOST} disabled={busy !== null} onClick={dismiss}>
              {busy === "dismiss" ? "Dismissing" : "Dismiss"}
            </button>
          </>
        ) : (
          <p className="dense text-ink-soft">{whoDecides(s.kind)}</p>
        )}
      </div>
    </li>
  );
}
