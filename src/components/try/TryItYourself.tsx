"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { tryApproveAction, tryAttachAction, tryCorrectAction, tryPayAction, tryRejectAction, trySubmitAction, type TryEvidence, type TryResult, type TryStatus } from "./actions";
import { AutoPlayer, FOCUSABLE, TRY_STEPS, TRY_TOTAL, navigate, progressLabel, trapNext, type TryNav, type TryNavEvent } from "./flow";
import { TRY_SAMPLES, editField, fieldsFor, parseAmountMinor, sampleById, type SampleId, type TryFields } from "./samples";

/** Shown wherever the request text is read. */
export const READER_NOTE = "On the live product Claude reads this; the demo uses the rule-based reader.";

type Live = { sampleId: SampleId; fields: TryFields; evidence: TryEvidence | null; status: TryStatus | null; correctTo: string };

const reduceMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Try it yourself: a clerk's desk with the six steps a staff member takes on one supplier payment, prefilled with a
 * sample the judge can keep or type over. Guided mode (the default) dims everything but the one field or button that
 * matters, with a note on what a staff member does there; Back, Next and Exit move through it. Auto mode plays the
 * same steps by itself, about four seconds each, with Pause and Resume. Every button calls the server action the
 * real page calls (actions.ts), in this visitor's own copy of the demo, on simulated rails.
 */
export function TryItYourself({ initialSample = "clean", startGuided = true }: { initialSample?: SampleId; startGuided?: boolean }) {
  const first = sampleById(initialSample) ?? TRY_SAMPLES[0];
  const [sampleId, setSampleId] = useState<SampleId>(first.id);
  const [fields, setFields] = useState<TryFields>(() => fieldsFor(first));
  const [evidence, setEvidence] = useState<TryEvidence | null>(null);
  const [status, setStatus] = useState<TryStatus | null>(null);
  const [correctTo, setCorrectTo] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nav, setNav] = useState<TryNav>(startGuided ? { status: "on", index: 0 } : { status: "off" });
  const [auto, setAuto] = useState<AutoPlayer["state"]>("idle");
  const sample = sampleById(sampleId) ?? TRY_SAMPLES[0];

  // The auto player and the async steps read the latest values from here, never from a stale render.
  const live = useRef<Live>({ sampleId, fields, evidence, status, correctTo });
  const navRef = useRef(nav);
  useLayoutEffect(() => {
    live.current = { sampleId, fields, evidence, status, correctTo };
    navRef.current = nav;
  });

  const go = useCallback((e: TryNavEvent) => setNav((s) => navigate(s, e)), []);

  const pickSample = (id: SampleId) => {
    const s = sampleById(id);
    if (!s) return;
    setSampleId(id);
    setFields(fieldsFor(s));
    setEvidence(null);
    setStatus(null);
    setCorrectTo("");
    setMessage(null);
  };

  const result = (r: TryResult<unknown>) => setMessage({ ok: r.ok, text: r.message });

  const run = async <T,>(label: string, fn: () => Promise<TryResult<T>>): Promise<TryResult<T>> => {
    setBusy(label);
    try {
      const r = await fn();
      result(r);
      return r;
    } catch (e) {
      const r = { ok: false as const, message: (e as Error).message || "Something went wrong. Try again." };
      result(r);
      return r;
    } finally {
      setBusy(null);
    }
  };

  const showStatus = (s: TryStatus | undefined) => {
    if (!s) return;
    setStatus(s);
    if (s.action?.kind === "amend_amount") setCorrectTo((s.action.amountMinor / 100).toFixed(2));
  };

  const attach = async () => {
    const r = await run("attach", () => tryAttachAction(live.current.sampleId));
    if (r.ok && r.data) setEvidence(r.data);
    return r.ok;
  };
  const submit = async () => {
    const { fields: f, evidence: ev } = live.current;
    const r = await run("submit", () => trySubmitAction({ text: f.text, evidence: ev }));
    if (r.ok) showStatus(r.data);
    return r.ok;
  };
  const correct = async (amount?: string) => {
    const s = live.current.status;
    if (!s) return false;
    const r = await run("correct", () => tryCorrectAction(s.id, amount ?? live.current.correctTo));
    if (r.ok) showStatus(r.data);
    return r.ok;
  };
  const reject = async () => {
    const s = live.current.status;
    if (!s) return false;
    const r = await run("reject", () => tryRejectAction(s.id));
    if (r.ok) showStatus(r.data);
    return r.ok;
  };
  const approve = async () => {
    const s = live.current.status;
    if (!s) return false;
    const r = await run("approve", () => tryApproveAction(s.id, s.shownWarnings));
    if (r.ok) showStatus(r.data);
    return r.ok;
  };
  const pay = async () => {
    const s = live.current.status;
    if (!s) return false;
    const rail = s.action?.kind === "pay" ? s.action.rail : s.rail ?? undefined;
    const r = await run("pay", () => tryPayAction(s.id, rail ?? undefined));
    if (r.ok) showStatus(r.data);
    return r.ok;
  };

  /** Auto mode: what a staff member does on arriving at a step. */
  const actOn = async (index: number) => {
    const { evidence: ev, status: st } = live.current;
    const id = TRY_STEPS[index]?.id;
    const decision = (sampleById(live.current.sampleId) ?? sample).decision;
    if (id === "evidence" && !ev) await attach();
    else if (id === "submit" && !st) await submit();
    else if (id === "decide" && st) {
      if (st.state === "blocked" && decision === "correct" && st.action?.kind === "amend_amount") await correct((st.action.amountMinor / 100).toFixed(2));
      else if (st.state === "blocked" && decision === "reject") await reject();
    } else if (id === "pay" && st?.state === "approved") await pay();
  };

  const player = useRef<AutoPlayer | null>(null);
  const actOnRef = useRef(actOn);
  useLayoutEffect(() => {
    actOnRef.current = actOn;
  });
  useEffect(() => {
    const p = new AutoPlayer(async () => {
      const n = navRef.current;
      const next = n.status === "on" ? n.index + 1 : 0;
      if (next >= TRY_TOTAL) {
        setNav({ status: "done" });
        return false;
      }
      navRef.current = { status: "on", index: next };
      setNav(navRef.current);
      await actOnRef.current(next);
      return true;
    }, setAuto);
    player.current = p;
    return () => p.stop();
  }, []);

  const play = () => {
    if (navRef.current.status !== "on") {
      // Starting from the top: a fresh copy of the sample, so the recording always shows the whole path.
      if (live.current.status) pickSample(live.current.sampleId);
      navRef.current = { status: "on", index: 0 };
      setNav(navRef.current);
    }
    player.current?.play();
  };
  const exit = () => {
    player.current?.stop();
    go({ type: "exit" });
  };

  const locked = Boolean(status);
  const amountMinor = parseAmountMinor(fields.amount);
  const step = nav.status === "on" ? TRY_STEPS[nav.index] : null;
  const state = status?.state ?? null;
  const decisionAction = status?.action ?? null;

  return (
    <div className="pb-[45vh] md:pb-40">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-[28px] font-semibold leading-[34px]">Try it yourself</h1>
          <p className="mt-2 text-ink-soft">One supplier payment, the way a clerk handles it: from the message to the books. Every button here is the real one, in your own copy of the demo, on simulated rails. No money moves.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="Mode">
          {auto === "playing" ? (
            <button type="button" className="btn" onClick={() => player.current?.pause()}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={play}>
              {auto === "paused" ? "Resume" : "Play"}
            </button>
          )}
          {nav.status === "off" ? (
            <button type="button" className="btn" onClick={() => go({ type: "start" })}>
              Guide me
            </button>
          ) : null}
        </div>
      </header>

      <fieldset className="panel mb-4 px-4 py-4 sm:px-5" disabled={auto === "playing"}>
        <legend className="sr-only">Pick a sample</legend>
        <p className="dense text-ink-soft" aria-hidden>
          Pick a sample
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Samples">
          {TRY_SAMPLES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={s.id === sampleId} onClick={() => pickSample(s.id)} className={`rounded-xl border px-3 py-2 text-left hairline ${s.id === sampleId ? "border-[color:var(--action)] bg-action-soft" : "bg-sheet"}`}>
              <span className="block font-medium">{s.name}</span>
              <span className="mt-0.5 block text-sm text-ink-soft">{s.expect}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <ol className="grid gap-4">
        <Section n={1} title="The request" target="request">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Payee" id="try-payee" value={fields.payee} disabled={locked} onChange={(v) => setFields((f) => editField(sample, f, "payee", v))} />
            <Field label={`Amount (${sample.currency})`} id="try-amount" value={fields.amount} disabled={locked} inputMode="decimal" invalid={amountMinor === null} onChange={(v) => setFields((f) => editField(sample, f, "amount", v))} />
            <Field label="Reference" id="try-reference" value={fields.reference} disabled={locked} onChange={(v) => setFields((f) => editField(sample, f, "reference", v))} />
          </div>
          <label htmlFor="try-text" className="mt-3 block text-sm font-medium">
            Request text, as the supplier sent it
          </label>
          <textarea id="try-text" className="field mt-1 w-full" rows={3} value={fields.text} disabled={locked} aria-describedby="try-reader-note" onChange={(e) => setFields((f) => editField(sample, f, "text", e.target.value))} />
          <p id="try-reader-note" className="mt-1 text-sm text-ink-soft">
            {READER_NOTE}
          </p>
        </Section>

        <Section n={2} title="The evidence" target="evidence">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{sample.document.label}</p>
              <p className="text-sm text-ink-soft">
                {sample.document.says}.{" "}
                <a className="link" href={`/demo-documents/${sample.document.file}`} target="_blank" rel="noreferrer">
                  Open the PDF
                </a>
              </p>
            </div>
            {evidence ? (
              <p className="text-sm text-settled" role="status">
                Attached. The PDF reader found {evidence.rows.map((r) => `${r.amountMinor !== null ? formatMoney(r.amountMinor, r.currency) : "no amount"}${r.reference ? `, ${r.reference}` : ""}`).join("; ") || "no figures"}.
              </p>
            ) : (
              <button type="button" className="btn" disabled={locked || busy !== null} onClick={() => void attach()}>
                {busy === "attach" ? "Attaching" : "Attach this document"}
              </button>
            )}
          </div>
        </Section>

        <Section n={3} title="Submit and see the checks" target="submit">
          {!status ? (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-primary" disabled={busy !== null || !fields.text.trim()} onClick={() => void submit()}>
                {busy === "submit" ? "Checking" : "Submit request"}
              </button>
              <span className="text-sm text-ink-soft">{evidence ? "With the document attached." : "No document attached yet: the checks will ask for one."}</span>
            </div>
          ) : (
            <div>
              <p className={`font-semibold ${toneClass(status.tone)}`}>{status.title}</p>
              {status.evidence ? <p className="mt-1 text-sm">{status.evidence}</p> : null}
              <ul className="mt-3 grid gap-1 text-sm" aria-label="Checks">
                {status.rules.map((r, i) => (
                  <li key={`${r.ruleId}:${i}`} className="flex gap-2">
                    <span className={`w-14 shrink-0 dense ${r.passed ? "text-settled" : r.severity === "block" ? "text-blocked" : "text-attention"}`}>{r.passed ? "Passed" : r.severity === "block" ? "Failed" : "Look"}</span>
                    <span>{r.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        <Section n={4} title="Approve, correct or reject" target="decide">
          {!status ? (
            <p className="text-sm text-ink-soft">After the checks.</p>
          ) : state === "blocked" ? (
            <div className="flex flex-wrap items-end gap-2">
              {decisionAction?.kind === "amend_amount" ? (
                <>
                  <div>
                    <label htmlFor="try-correct" className="block text-sm font-medium">
                      Corrected amount ({status.currency ?? "USD"})
                    </label>
                    <input id="try-correct" className="field num mt-1 w-32" inputMode="decimal" value={correctTo} onChange={(e) => setCorrectTo(e.target.value)} />
                  </div>
                  <button type="button" className="btn btn-primary" disabled={busy !== null || parseAmountMinor(correctTo) === null} onClick={() => void correct()}>
                    {busy === "correct" ? "Correcting" : parseAmountMinor(correctTo) === decisionAction.amountMinor ? decisionAction.label : `Correct to ${formatMoney(parseAmountMinor(correctTo) ?? 0, status.currency)}`}
                  </button>
                </>
              ) : null}
              <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void reject()}>
                {busy === "reject" ? "Cancelling" : "Cancel request"}
              </button>
            </div>
          ) : state === "awaiting_approval" ? (
            <div>
              <p className="text-sm">It waits for an approver. Checkrail never lets the person who prepared a payment approve it, so try Approve: it refuses you, as it would a clerk.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn" disabled={busy !== null} onClick={() => void approve()}>
                  {busy === "approve" ? "Approving" : "Approve"}
                </button>
                <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void reject()}>
                  {busy === "reject" ? "Cancelling" : "Cancel request"}
                </button>
              </div>
            </div>
          ) : state === "approved" ? (
            <p className="text-sm">Approved by policy: every check passed and it is under the line where a person signs. Above it, an approver would sign here.</p>
          ) : state === "cancelled" ? (
            <p className="text-sm">Cancelled. No money moved, and it counts in Errors prevented.</p>
          ) : (
            <p className="text-sm">Nothing to decide: it is {state?.replace(/_/g, " ")}.</p>
          )}
        </Section>

        <Section n={5} title="Pay (simulated rails)" target="pay">
          {state === "approved" ? (
            <button type="button" className="btn btn-settled" disabled={busy !== null} onClick={() => void pay()}>
              {busy === "pay" ? "Paying" : decisionAction?.kind === "pay" ? `${decisionAction.label} (simulated)` : "Pay (simulated)"}
            </button>
          ) : status?.settled ? (
            <p className="text-sm text-settled">
              Paid {formatMoney(status.settled.grossMinor, status.settled.grossCurrency)} by {status.settled.rail === "paypal" ? "PayPal" : status.settled.rail} (simulated).
            </p>
          ) : (
            <p className="text-sm text-ink-soft">{status ? "Not payable: only an approved request can be paid." : "After approval."}</p>
          )}
        </Section>

        <Section n={6} title="In the books and the Daily close" target="books">
          {status?.settled ? (
            <div className="text-sm">
              <p>The payment is in the ledger, and a bill and payment record {status.books ? `waits for export to the accountant (${status.books.destination === "xero" ? "Xero" : "CSV"})` : "is on its way to the accountant"}. The Daily close lists it under what people sent today.</p>
            </div>
          ) : status ? (
            <p className="text-sm">Nothing reaches the books until it is paid. {state === "blocked" || state === "cancelled" ? "The Daily close lists what was stopped." : ""}</p>
          ) : (
            <p className="text-sm text-ink-soft">After payment.</p>
          )}
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {status ? (
              <Link className="link" href={`/obligations/${status.id}`}>
                Open the request
              </Link>
            ) : null}
            <Link className="link" href="/ledger">
              Ledger
            </Link>
            <Link className="link" href="/close">
              Daily close
            </Link>
          </p>
        </Section>
      </ol>

      <p role="status" aria-live="polite" className={`mt-4 min-h-[20px] text-sm ${message ? (message.ok ? "text-settled" : "text-blocked") : ""}`}>
        {message?.text ?? ""}
      </p>
      {status ? (
        <button type="button" className="btn mt-2" disabled={auto === "playing"} onClick={() => pickSample(sampleId)}>
          Try this sample again
        </button>
      ) : null}

      {step && nav.status === "on" ? (
        <Spotlight
          key="spotlight"
          index={nav.index}
          title={step.title}
          note={step.note}
          target={step.target}
          auto={auto}
          onBack={() => {
            player.current?.pause();
            go({ type: "back" });
          }}
          onNext={() => {
            player.current?.pause();
            go({ type: "next" });
          }}
          onExit={exit}
          onPlay={play}
          onPause={() => player.current?.pause()}
        />
      ) : null}
      {nav.status === "done" ? <Finished onClose={exit} onAgain={() => { pickSample(sampleId); setNav({ status: "on", index: 0 }); }} onBack={() => go({ type: "back" })} /> : null}
    </div>
  );
}

function toneClass(tone: string): string {
  return tone === "blocked" ? "text-blocked" : tone === "attention" ? "text-attention" : tone === "settled" ? "text-settled" : "";
}

function Section({ n, title, target, children }: { n: number; title: string; target: string; children: React.ReactNode }) {
  return (
    <li data-try={target} className="panel scroll-mt-4 px-4 py-4 sm:px-5" aria-labelledby={`try-step-${n}`}>
      <h2 id={`try-step-${n}`} className="mb-3 text-base font-semibold">
        <span className="dense mr-2 text-ink-soft">{n}</span>
        {title}
      </h2>
      {children}
    </li>
  );
}

function Field({ label, id, value, onChange, disabled, inputMode, invalid }: { label: string; id: string; value: string; onChange: (v: string) => void; disabled?: boolean; inputMode?: "decimal"; invalid?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input id={id} className="field mt-1 w-full" value={value} disabled={disabled} inputMode={inputMode} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

type Box = { top: number; left: number; width: number; height: number };

/**
 * The guided overlay: the page dimmed in four panels around the lit element (so clicks outside it do nothing), and a
 * coach card with the step's note and Back, Next and Exit. A modal dialog: Tab and Shift+Tab cycle through the lit
 * element and the card, Escape exits, and each step moves focus to its title.
 */
export function Spotlight(p: { index: number; title: string; note: string; target: string; auto: AutoPlayer["state"]; onBack: () => void; onNext: () => void; onExit: () => void; onPlay: () => void; onPause: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const last = p.index === TRY_TOTAL - 1;

  // Follow the lit element: scroll it into the space above the card once per step, then track it.
  useLayoutEffect(() => {
    let stopped = false;
    let scrolled = false;
    const update = () => {
      if (stopped) return;
      const el = document.querySelector<HTMLElement>(`[data-try="${p.target}"]`);
      if (!el) return setBox(null);
      const r = el.getBoundingClientRect();
      if (!scrolled) {
        scrolled = true;
        const c = card.current?.getBoundingClientRect();
        const room = (c && c.top > 80 && c.left < r.right && c.right > r.left ? c.top : window.innerHeight) - 16;
        if (r.top < 8 || r.bottom > room) window.scrollBy({ top: r.top - Math.max(12, (room - r.height) / 2 > 12 && r.height < room ? (room - r.height) / 2 : 12), behavior: reduceMotion() ? "auto" : "smooth" });
      }
      const n = el.getBoundingClientRect();
      setBox((b) => (b && b.top === n.top && b.left === n.left && b.width === n.width && b.height === n.height ? b : { top: n.top, left: n.left, width: n.width, height: n.height }));
    };
    update();
    const timer = window.setInterval(update, 150);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [p.target, p.index]);

  // Each step announces itself by moving focus to its title.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [p.index]);

  // The focus trap and Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        p.onExit();
        return;
      }
      if (e.key !== "Tab") return;
      const lit = document.querySelector<HTMLElement>(`[data-try="${p.target}"]`);
      const all = [...(lit ? Array.from(lit.querySelectorAll<HTMLElement>(FOCUSABLE)) : []), ...(card.current ? Array.from(card.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : [])].filter((el) => el.getClientRects().length > 0);
      const at = all.indexOf(document.activeElement as HTMLElement);
      const to = trapNext(all.length, at, e.shiftKey);
      if (to < 0) return;
      e.preventDefault();
      all[to].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [p]);

  const pad = 8;
  const hole = box ? { top: Math.max(0, box.top - pad), left: Math.max(0, box.left - pad), right: box.left + box.width + pad, bottom: box.top + box.height + pad } : null;
  const dim = "fixed z-[60] bg-[rgb(10_22_40_/_0.55)]";
  const move = reduceMotion() ? "" : "transition-[top,left,width,height] duration-200 ease-out";

  return (
    <>
      {hole ? (
        <div aria-hidden data-try-dim>
          <div className={`${dim} ${move} left-0 right-0 top-0`} style={{ height: hole.top }} />
          <div className={`${dim} ${move} left-0 right-0 bottom-0`} style={{ top: hole.bottom }} />
          <div className={`${dim} ${move} left-0`} style={{ top: hole.top, height: hole.bottom - hole.top, width: hole.left }} />
          <div className={`${dim} ${move} right-0`} style={{ top: hole.top, height: hole.bottom - hole.top, left: hole.right }} />
          <div className={`pointer-events-none fixed z-[60] rounded-[14px] ${move}`} style={{ top: hole.top, left: hole.left, width: hole.right - hole.left, height: hole.bottom - hole.top, boxShadow: "0 0 0 2px var(--action)" }} />
        </div>
      ) : (
        <div aria-hidden data-try-dim className="fixed inset-0 z-[60] bg-[rgb(10_22_40_/_0.55)]" />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="try-coach-title"
        aria-describedby="try-coach-note"
        className="panel fixed inset-x-0 bottom-0 z-[61] max-h-[45vh] overflow-y-auto rounded-b-none px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-3 shadow-lg md:inset-x-auto md:bottom-6 md:right-6 md:w-[380px] md:rounded-2xl md:px-5 md:pb-4 md:pt-4"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="dense text-ink-soft">{progressLabel(p.index)}</p>
          <button type="button" className="link dense text-ink-soft" onClick={p.onExit} aria-label="Exit the guide (Escape)">
            Exit
          </button>
        </div>
        <div className="mt-1.5 flex gap-1" role="progressbar" aria-label="Progress" aria-valuemin={1} aria-valuemax={TRY_TOTAL} aria-valuenow={p.index + 1} aria-valuetext={progressLabel(p.index)}>
          {TRY_STEPS.map((s, i) => (
            <span key={s.id} className="h-1 flex-1 rounded-full" style={{ background: i <= p.index ? "var(--action)" : "var(--rule)" }} />
          ))}
        </div>
        <h2 id="try-coach-title" ref={heading} tabIndex={-1} className="mt-3 text-base font-semibold outline-none">
          {p.title}
        </h2>
        <p id="try-coach-note" className="mt-1 text-ink-soft">
          {p.note}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          {p.auto === "playing" ? (
            <button type="button" className="btn btn-sm" onClick={p.onPause}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={p.onPlay}>
              {p.auto === "paused" ? "Resume" : "Play"}
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm" disabled={p.index === 0} onClick={p.onBack}>
              Back
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={p.onNext}>
              {last ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function Finished({ onClose, onAgain, onBack }: { onClose: () => void; onAgain: () => void; onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <section role="region" aria-label="Try it yourself, finished" className="panel fixed inset-x-0 bottom-0 z-[45] px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-3 md:inset-x-auto md:bottom-6 md:right-6 md:w-[380px] md:rounded-2xl md:px-5 md:pb-4 md:pt-4">
      <p className="dense text-settled">Done</p>
      <h2 ref={heading} tabIndex={-1} className="mt-1 text-base font-semibold outline-none">
        That is the whole path
      </h2>
      <p className="mt-1 text-ink-soft">Pick another sample, or type your own figures and watch the checks change. Start over on the overview gives you a fresh copy.</p>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-sm" onClick={onAgain}>
          Run it again
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
