"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { amendAction, approveAction, confirmAction, executeAction, reconcileAction, rejectAction, retryFailedAction, type ActionResult } from "@/app/actions";
import type { Rail } from "@/lib/domain/types";
import { useToast } from "./Toast";
import { useStage } from "./ObligationStage";
import type { Decision, DecisionTone, PrimaryAction } from "./decision-model";

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

/** Whether this viewer may take the card's action. The server checks again. */
function allowed(a: PrimaryAction, perms: Perms, approveRefusal: string | null | undefined): boolean {
  switch (a.kind) {
    case "amend_amount":
    case "reject":
      return perms.amend;
    case "approve":
      return perms.approve && !approveRefusal;
    case "pay":
    case "retry":
    case "reconcile":
      return perms.pay;
    case "confirm":
      return true;
  }
}

function usePrimary(id: string, action: PrimaryAction | null, shownWarnings: string[]) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const { travel } = useStage();
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
          r = await approveAction(id, undefined, shownWarnings);
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
export function DecisionCard({ id, decision, perms, approveRefusal, shownWarnings = [] }: { id: string; decision: Decision; perms: Perms; approveRefusal?: string | null; shownWarnings?: string[] }) {
  const tone = TONE[decision.tone];
  const action = decision.action && allowed(decision.action, perms, approveRefusal) ? decision.action : null;
  const { fire, pending, busy } = usePrimary(id, action, shownWarnings);
  const ref = useRef<HTMLElement>(null);
  const [cardVisible, setCardVisible] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setCardVisible(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const waiting = decision.action && !action ? (decision.action.kind === "approve" && approveRefusal ? approveRefusal : "Someone with the right role takes this step.") : null;
  const evidenceLink = decision.evidenceLink;

  return (
    <>
      <section
        ref={ref}
        aria-label="Decision"
        className="mt-4 flex flex-col gap-4 rounded-md bg-sheet py-4 pl-5 pr-5 sm:flex-row sm:items-center sm:justify-between sm:pl-6"
        style={{ boxShadow: `inset 4px 0 0 ${tone.rule}`, background: `linear-gradient(${tone.soft}, ${tone.soft}), var(--sheet)` }}
      >
        <div className="min-w-0">
          <h2 className="flex items-start gap-2 text-lg font-semibold leading-6" style={{ color: tone.text }}>
            <span className="mt-[3px]">
              <ToneIcon icon={tone.icon} />
            </span>
            <span className="min-w-0">{decision.title}</span>
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
          {waiting ? <p className="mt-1 pl-[26px] text-xs text-ink-soft">{waiting}</p> : null}
        </div>
        {action ? (
          <div className="shrink-0 pl-[26px] sm:pl-0">
            <button type="button" className={buttonClass(action)} disabled={pending} onClick={fire}>
              {busy ? busyLabel(action) : action.label}
            </button>
          </div>
        ) : null}
      </section>

      {action ? (
        <>
          <div
            className={`fixed inset-x-0 bottom-[51px] z-30 border-t bg-sheet px-4 py-2.5 transition-transform motion-reduce:transition-none md:bottom-0 md:left-16 lg:hidden ${cardVisible ? "pointer-events-none translate-y-[calc(100%+51px)]" : "translate-y-0"}`}
            style={{ boxShadow: `inset 0 3px 0 ${tone.rule}`, borderColor: "var(--rule)" }}
            aria-hidden={cardVisible}
          >
            <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-3">
              <p className="min-w-0 truncate text-xs font-medium" style={{ color: tone.text }}>
                {decision.title}
              </p>
              <button type="button" className={`${buttonClass(action)} shrink-0`} disabled={pending} onClick={fire} tabIndex={cardVisible ? -1 : 0}>
                {busy ? busyLabel(action) : action.label}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
