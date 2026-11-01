"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { tourAutopilotAction, tourDemoAgentAction, type TourActionResult } from "./actions";
import { setTourState, takeFocusRequest, useTourState } from "./store";
import styles from "./Tour.module.css";
import { TOUR_STEPS, TOUR_TOTAL, finale, move, nextLabel, outlivedCopy, progressLabel, resolvePath, stepOnPage, type TourIds, type TourState, type TourTarget } from "./steps";

/**
 * The judge tour: a small card (bottom right on a desktop, a bottom sheet above the phone navigation) that walks the
 * eight steps, with a soft ring around what to look at. Next and Back go to the step's page. Progress is a cookie
 * (store.ts), tied to the copy of the demo it was taken in (`copy`): a tour that outlives its copy offers to start
 * again. Escape, from anywhere, folds the card to a chip and focus goes to the chip; the chip opens it again. Each
 * step is announced once, by moving focus to its title when the visitor starts or moves through the tour (no live
 * region as well, which would read it twice).
 */
export function Tour({ initial, ids, sandbox, copy }: { initial: TourState; ids: TourIds; sandbox: boolean; copy: string | null }) {
  const state = useTourState(initial);
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [folded, setFolded] = useState(false);
  const [result, setResult] = useState<{ index: number; r: TourActionResult } | null>(null);
  const [pending, start] = useTransition();
  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLElement>(null);
  const moved = useRef(false);
  const chip = useRef<HTMLButtonElement>(null);
  const foldedByUser = useRef(false);
  // A page the card itself is taking the visitor to, and the page they were on: while that navigation is under way
  // the card already shows the next step, instead of "on another page".
  const [arriving, setArriving] = useState<{ to: string; from: string } | null>(null);

  const index = state.status === "on" ? state.index : -1;
  const step = index >= 0 ? TOUR_STEPS[index] : null;
  const here = step ? stepOnPage(step, pathname, ids) : null;
  const stepPath = step ? resolvePath(step.path, ids) : null;

  // A tour started without a copy stamp (Take the tour) takes the current copy's.
  useEffect(() => {
    if (state.status === "on" && !state.copy && copy) setTourState({ ...state, copy });
  }, [state, copy]);

  // Escape folds the card from anywhere on the page, unless something else already used the key.
  useEffect(() => {
    if (state.status === "off" || folded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      foldedByUser.current = true;
      setFolded(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.status, folded]);

  // Folding moves focus to the chip; opening it again moves focus back to the step title.
  useEffect(() => {
    if (!foldedByUser.current) return;
    foldedByUser.current = false;
    if (folded) chip.current?.focus();
    else heading.current?.focus();
  }, [folded]);

  // Focus the step title after the visitor started the tour or moved through it from the card (not on a page load).
  useEffect(() => {
    if (takeFocusRequest()) moved.current = true;
    if (!moved.current) return;
    if (step && stepPath && stepPath !== pathname.replace(/(.)\/+$/, "$1")) return; // still navigating
    moved.current = false;
    heading.current?.focus();
  }, [index, pathname, step, stepPath, state.status]);

  const go = useCallback(
    (next: TourState) => {
      moved.current = true;
      setFolded(false);
      setTourState(next);
      if (next.status === "on") {
        const p = resolvePath(TOUR_STEPS[next.index].path, ids);
        if (p && p !== pathname) {
          const trip = { to: p, from: pathname };
          setArriving(trip);
          router.push(p);
          // A navigation can be dropped (for example behind a button's refresh still under way). If the page has not
          // changed after a few seconds, the card goes back to offering "Go to this step".
          window.setTimeout(() => setArriving((a) => (a === trip ? null : a)), 5000);
        }
      }
    },
    [ids, pathname, router],
  );

  const runAction = (kind: "autopilot" | "demo-agent", at: number) =>
    start(async () => {
      const r = kind === "autopilot" ? await tourAutopilotAction() : await tourDemoAgentAction();
      setResult({ index: at, r });
      router.refresh();
    });

  if (state.status === "off") return null;

  if (folded) {
    return (
      <button
        ref={chip}
        type="button"
        className="btn btn-sm fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-4 z-[45] shadow-md md:bottom-6 md:right-6"
        onClick={() => {
          foldedByUser.current = true;
          setFolded(false);
        }}
        aria-label="Open the tour again"
      >
        Tour{step ? `, ${progressLabel(index).toLowerCase()}` : ""}
      </button>
    );
  }

  const shell = (children: React.ReactNode, label: string) => (
    <section
      ref={card}
      role="region"
      aria-label={label}
      className={`panel ${styles.sheet} fixed inset-x-0 bottom-[calc(57px+env(safe-area-inset-bottom))] z-[45] max-h-[60vh] overflow-y-auto px-4 pb-4 pt-3 md:inset-x-auto md:bottom-6 md:right-6 md:max-h-[calc(100vh-48px)] md:w-[380px] md:px-5 md:pt-4`}
    >
      {children}
    </section>
  );

  if (state.status === "done") {
    const f = finale(sandbox);
    return shell(
      <>
        <p className="dense text-settled">Tour complete</p>
        <h2 ref={heading} tabIndex={-1} className="mt-1 text-base font-semibold outline-none">
          {f.title}
        </h2>
        <p className="mt-1 text-ink-soft">{f.body}</p>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn btn-sm" onClick={() => go({ status: "on", index: TOUR_TOTAL - 1 })}>
            Back
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setTourState({ status: "off" })}>
            Close
          </button>
        </div>
      </>,
      "Guided tour, finished",
    );
  }

  if (!step) return null;
  if (outlivedCopy(state, copy)) {
    return shell(
      <>
        <p className="dense text-ink-soft">{progressLabel(index)}</p>
        <h2 ref={heading} tabIndex={-1} className="mt-1 text-base font-semibold outline-none">
          This is a fresh copy of the demo
        </h2>
        <p className="mt-1 text-ink-soft">{sandbox ? "Your copy was replaced (Start over, or it was deleted after a while without use), so what you did in the earlier steps is gone." : "The demo was reset, so what you did in the earlier steps is gone."} Start the tour again from step 1.</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="link text-sm text-ink-soft" onClick={() => setTourState({ status: "off" })}>
            Skip tour
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => go(copy ? { status: "on", index: 0, copy } : { status: "on", index: 0 })}>
            Start the tour again
          </button>
        </div>
      </>,
      "Guided tour",
    );
  }
  const done = result?.index === index && result.r.ok;
  const shown = here ?? (arriving && arriving.to === stepPath && arriving.from === pathname ? {} : null);
  const actionPrimary = Boolean(step.action && shown && !done);
  return (
    <>
      {here?.target ? <Ring target={here.target} avoid={card} key={`${index}:${pathname}`} /> : null}
      {shell(
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="dense text-ink-soft">{progressLabel(index)}</p>
            <button
              type="button"
              className="link dense text-ink-soft"
              onClick={() => {
                foldedByUser.current = true;
                setFolded(true);
              }}
              aria-label="Fold the tour away (Escape)"
            >
              Hide
            </button>
          </div>
          <div className="mt-1.5 flex gap-1" role="progressbar" aria-label="Tour progress" aria-valuemin={1} aria-valuemax={TOUR_TOTAL} aria-valuenow={index + 1} aria-valuetext={progressLabel(index)}>
            {TOUR_STEPS.map((s, i) => (
              <span key={s.id} className="h-1 flex-1 rounded-full" style={{ background: i <= index ? "var(--action)" : "var(--rule)" }} />
            ))}
          </div>
          <h2 ref={heading} tabIndex={-1} className="mt-3 text-base font-semibold outline-none">
            {step.title}
          </h2>
          {shown ? <p className="mt-1 text-ink-soft">{step.body}</p> : <p className="mt-1 text-ink-soft">{stepPath ? "This step is on another page." : "This step needs the demo story, which is not loaded. Start over on the Demo guide to load it."}</p>}
          {shown ? (
            <p className="mt-3 rounded-lg bg-action-soft px-3 py-2">
              <span className="font-medium">Do: </span>
              {step.doThis}
            </p>
          ) : null}
          {result?.index === index ? (
            <p role="status" className={`mt-2 text-sm ${result.r.ok ? "text-settled" : "text-blocked"}`}>
              {result.r.message}
            </p>
          ) : null}
          {shown && step.action && !done ? (
            <div className="mt-3">
              <button type="button" className={`btn ${actionPrimary ? "btn-primary" : ""}`} disabled={pending} onClick={() => runAction(step.action!.kind, index)}>
                {pending ? step.action.busy : step.action.label}
              </button>
              {step.action.kind === "demo-agent" ? <span className="ml-2 dense text-ink-soft">A demo agent, not a real one</span> : null}
            </div>
          ) : null}
          {here && step.link && pathname !== step.link.href ? (
            <p className="mt-2">
              <a
                href={step.link.href}
                className="link"
                onClick={(e) => {
                  e.preventDefault();
                  router.push(step.link!.href);
                }}
              >
                {step.link.label}
              </a>
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="link text-sm text-ink-soft" onClick={() => setTourState({ status: "off" })}>
              Skip tour
            </button>
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm" disabled={index === 0} onClick={() => go(move(state, -1))}>
                Back
              </button>
              {shown || !stepPath ? (
                <button type="button" className={`btn btn-sm ${actionPrimary ? "" : "btn-primary"}`} onClick={() => go(move(state, 1))}>
                  {nextLabel(index)}
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-primary" onClick={() => go(state)}>
                  Go to this step
                </button>
              )}
            </div>
          </div>
        </>,
        "Guided tour",
      )}
    </>
  );
}

/** The innermost element matching the target: the first in page order that has no matching element inside it. */
function findTarget(t: TourTarget): HTMLElement | null {
  let all: HTMLElement[];
  try {
    all = Array.from(document.querySelectorAll<HTMLElement>(t.selector));
  } catch {
    return null;
  }
  const visible = all.filter((el) => el.getClientRects().length > 0 && !el.closest('[aria-label^="Guided tour"]'));
  const hits = t.text ? visible.filter((el) => (el.textContent ?? "").includes(t.text!)) : visible;
  return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) ?? null;
}

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A soft ring around the target, drawn over the page without touching it. Follows scrolling and layout changes. */
function Ring({ target, avoid }: { target: TourTarget; avoid: React.RefObject<HTMLElement | null> }) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const el = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    let stopped = false;
    // Moving the target into view waits a moment after the page arrives (the router scrolls a new page to the top
    // as it commits), then checks up to twice more while a smooth scroll settles.
    let checksLeft = 3;
    let nextCheck = performance.now() + 350;
    const update = () => {
      if (stopped) return;
      // Find it again when it went away, or when React reused the element for something else (Correct becomes Approve).
      if (!el.current || !el.current.isConnected || (target.text && !(el.current.textContent ?? "").includes(target.text))) el.current = findTarget(target);
      const node = el.current;
      if (!node) return setBox(null);
      const now = performance.now();
      if (checksLeft > 0 && now >= nextCheck) {
        const r = node.getBoundingClientRect();
        const c = avoid.current?.getBoundingClientRect();
        const behavior: ScrollBehavior = reduceMotion() ? "auto" : "smooth";
        // Keep it in view and clear of the card: the space to use ends where the card starts, when the card is in
        // the same column (always on a phone). Centre it in that space, or put its top near the top when it is taller.
        const bottom = (c && r.right > c.left && r.left < c.right ? c.top : window.innerHeight) - 16;
        if (r.top >= 8 && r.bottom <= bottom) checksLeft = 0;
        else window.scrollBy({ top: r.top - (r.height + 32 <= bottom ? Math.max(16, (bottom - r.height) / 2) : 16), behavior });
        checksLeft = Math.max(0, checksLeft - 1);
        nextCheck = now + 700;
      }
      // Only follows it from here: the page is not scrolled again when the target grows.
      const r = node.getBoundingClientRect();
      setBox((b) => (b && b.top === r.top && b.left === r.left && b.width === r.width && b.height === r.height ? b : { top: r.top, left: r.left, width: r.width, height: r.height }));
    };
    update();
    const timer = window.setInterval(update, 250);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [target, avoid]);

  if (!box) return null;
  const pad = 6;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-[44] rounded-[18px] motion-safe:transition-[top,left,width,height] motion-safe:duration-200"
      style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2, boxShadow: "0 0 0 2px var(--action), 0 0 0 7px var(--action-soft)" }}
    />
  );
}
