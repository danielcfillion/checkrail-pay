"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { amendAction, approveAction, confirmAction, executeAction, reconcileAction, rejectAction, retryFailedAction, type ActionResult } from "@/app/actions";
import type { Rail } from "@/lib/domain/types";
import { useToast } from "./Toast";
import { useStage } from "./ObligationStage";
import { allowedAction, type Decision, type DecisionTone, type PrimaryAction } from "./decision-model";

type Perms = { approve: boolean; pay: boolean; amend: boolean };

const TONE: Record<DecisionTone, { rule: string; text: string; soft: string; icon: "x" | "clock" | "tick" | "dot" }> = {
  blocked: { rule: "var(--blocked)", text: "var(--blocked)", soft: "var(--blocked-soft)", icon: "x" },
  attention: { rule: "var(--attention)", text: "var(--attention)", soft: "var(--attention-soft)", icon: "clock" },
  settled: { rule: "var(--settled)", text: "var(--settled)", soft: "var(--settled-soft)", icon: "tick" },
  neutral: { rule: "var(--rule-strong)", text: "var(--ink)", soft: "transparent", icon: "dot" },
};

function ToneIcon({ icon }: { icon: (typeof TONE)[DecisionTone]["icon"] }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <circle cx="9" cy="9" r="7.25" />
      {icon === "x" ? <path d="M6.5 6.5l5 5M11.5 6.5l-5 5" /> : null}
      {icon === "clock" ? <path d="M9 5.5V9l2.25 1.5" /> : null}
      {icon === "tick" ? <path d="M5.75 9.25l2.25 2.25 4.25-4.75" /> : null}
      {icon === "dot" ? <circle cx="9" cy="9" r="1.5" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

function usePrimary(id: string, action: PrimaryAction | null, shownWarnings: string[]) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const { travel, note } = useStage();
  const fire = () => {
    if (!action) return;
    setBusy(true);
    start(async () => {
      let r: ActionResult;
      switch (action.kind) {
        case "amend_amount":
          r = await amendAction(id, { amountMinor: action.amountMinor }, action.note);
          break;
        case "approve":
          r = await approveAction(id, note.trim() || undefined, shownWarnings);
          break;
        case "pay":
          r = await executeAction(id, action.rail as Rail);
          if (r.ok) {
            travel(3);
            setTimeout(() => travel(4), 700);
            setTimeout(() => travel(undefined), 1800);
          }
          break;
        case "reject":
          r = await rejectAction(id, action.note);
          break;
        case "retry": {
          const back = await retryFailedAction(id);
          r = back.ok ? await executeAction(id, action.rail as Rail) : back;
          if (r.ok) travel(3);
          break;
        }
        case "reconcile":
          r = await reconcileAction(id);
          if (r.ok) travel(3);
          break;
        case "confirm":
          r = await confirmAction(id);
          if (r.ok) travel(4);
          break;
      }
      toast(r.message, r.ok ? "ok" : "error");
      setBusy(false);
      router.refresh();
    });
  };
  return { fire, pending, busy };
}

const busyLabel = (a: PrimaryAction) => {
  switch (a.kind) {
    case "amend_amount":
      return "Correcting";
    case "approve":
      return "Approving";
    case "pay":
      return a.label.replace(/^Pay/, "Paying");
    case "reject":
      return "Cancelling";
    case "retry":
      return a.label.replace(/^Retry/, "Retrying");
    case "reconcile":
      return "Asking the rail";
    case "confirm":
      return "Checking";
  }
};

const buttonClass = (a: PrimaryAction) => (a.kind === "reject" ? "btn btn-danger" : "btn btn-primary");

/**
 * The decision tier: one full-width card under the header that states the outcome in money, gives one line of
 * evidence and offers the one action that moves the request on. On phones a sticky bar above the bottom nav
 * carries the same action once the card has scrolled away.
 */
export function DecisionCard({ id, decision, perms, approveRefusal, shownWarnings = [], deciding }: { id: string; decision: Decision; perms: Perms; approveRefusal?: string | null; shownWarnings?: string[]; deciding?: string | null }) {
  const tone = TONE[decision.tone];
  const action = decision.action && allowedAction(decision.action, perms, approveRefusal) ? decision.action : null;
  const { fire, pending, busy } = usePrimary(id, action, shownWarnings);
  const ref = useRef<HTMLDivElement>(null);
  const [cardVisible, setCardVisible] = useState(true);

  // The phone bar takes over exactly when the card's own button leaves the screen (above the bottom nav), so the
  // primary action is on screen once, never twice.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setCardVisible(e.isIntersecting), { threshold: 0.5, rootMargin: "0px 0px -57px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [action]);

  const waiting = decision.action && !action ? (decision.action.kind === "approve" && approveRefusal ? approveRefusal : "Someone with the right role takes this step.") : null;
  const evidenceLink = decision.evidenceLink;

  return (
    <>
      <section
        aria-label="Decision"
        className="mt-4 flex flex-col gap-4 rounded-md bg-sheet py-4 pl-5 pr-5 sm:flex-row sm:items-center sm:justify-between sm:pl-6"
        style={{ boxShadow: `inset 4px 0 0 ${tone.rule}`, background: `linear-gradient(${tone.soft}, ${tone.soft}), var(--sheet)` }}
      >
        <div className="min-w-0">
          <h2 className="flex items-start gap-2 text-lg font-semibold leading-6" style={{ color: tone.text }}>
            <span className="mt-[3px]">
              <ToneIcon icon={tone.icon} />
            </span>
            <span className="min-w-0">
              {decision.title}
              {decision.chip ? (
                <span className="dense ml-2 inline-block whitespace-nowrap rounded-sm px-1.5 align-[1px]" style={{ background: "var(--sheet)", color: tone.text, boxShadow: `inset 0 0 0 1px ${tone.rule}` }}>
                  {decision.chip}
                </span>
              ) : null}
            </span>
          </h2>
          <p className="mt-1 pl-[26px] text-ink">
            {decision.evidence}
            {evidenceLink ? (
              <>
                {" "}
                <Link href={evidenceLink.href} className="link">
                  {evidenceLink.label}
                </Link>
                {evidenceLink.after ?? ""}
              </>
            ) : null}
          </p>
          {decision.note ? <p className="mt-1 pl-[26px] text-ink">{decision.note}</p> : null}
          {deciding ? <p className="mt-2 pl-[26px] text-xs leading-4 text-ink-soft">{deciding}</p> : null}
          {waiting ? <p className="mt-1 pl-[26px] text-xs text-ink-soft">{waiting}</p> : null}
        </div>
        {action ? (
          <div ref={ref} className={`shrink-0 pl-[26px] sm:max-w-[320px] sm:pl-0 sm:text-right ${cardVisible ? "" : "max-lg:invisible"}`}>
            {/* On a phone a long label wraps instead of running off the card. */}
            <button type="button" className={`${buttonClass(action)} max-sm:h-auto! max-sm:whitespace-normal! max-sm:py-2! max-sm:text-left pointer-coarse:h-11!`} disabled={pending} onClick={fire}>
              {busy ? busyLabel(action) : action.label}
            </button>
            {decision.actionHint && action.kind === "approve" ? <p className="mt-1.5 text-xs leading-4 text-ink-soft">{decision.actionHint}</p> : null}
          </div>
        ) : null}
      </section>

      {action ? (
        <>
          <div
            className={`fixed inset-x-0 bottom-[57px] z-30 border-t bg-sheet px-4 py-2.5 transition-transform motion-reduce:transition-none md:bottom-0 md:left-16 lg:hidden ${cardVisible ? "pointer-events-none translate-y-[calc(100%+57px)]" : "translate-y-0"}`}
            style={{ boxShadow: `inset 0 3px 0 ${tone.rule}`, borderColor: "var(--rule)" }}
            aria-hidden={cardVisible}
          >
            <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-3">
              <p className="min-w-0 truncate text-xs font-medium" style={{ color: tone.text }}>
                {decision.barText ?? decision.title}
              </p>
              <button type="button" className={`${buttonClass(action)} shrink-0 pointer-coarse:h-11!`} disabled={pending} onClick={fire} tabIndex={cardVisible ? -1 : 0}>
                {busy ? busyLabel(action) : action.kind === "approve" ? "Approve" : action.label}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
