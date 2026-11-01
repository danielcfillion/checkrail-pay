/**
 * The guided judge tour: eight fixed steps through the product as it is meant to be used, then "now explore on your
 * own". Pure data and functions, so the copy and the navigation are unit-tested; Tour.tsx renders it.
 *
 * Paths can name a seeded request (":phuong", ":duplicate", ":paypal"). Their ids are random per seed, so the
 * server looks them up and the tour fills them in (resolvePath).
 */

export type TourIds = { phuong?: string | null; duplicate?: string | null; paypal?: string | null };

/** What to highlight: the first element matching `selector` whose text contains `text` (the innermost such element). */
export type TourTarget = { selector: string; text?: string };

/** An in-card action, run by a server action (src/components/tour/actions.ts). */
export type TourActionKind = "autopilot" | "demo-agent";

export interface TourStep {
  id: string;
  title: string;
  /** One or two sentences: what this shows. */
  body: string;
  /** What to click. */
  doThis: string;
  /** The page Next and Back go to. */
  path: string;
  target?: TourTarget;
  /** Other pages where the card stays on this step, each with its own target. */
  alsoOn?: Array<{ path: string; target?: TourTarget }>;
  action?: { kind: TourActionKind; label: string; busy: string };
  link?: { href: string; label: string };
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "overview",
    title: "What waits on you",
    body: "The headline is what waits on you. Errors prevented is the money Checkrail stopped: USD 160 Phuong would have been overpaid, plus a USD 180 job PayPal had already paid.",
    doThis: "Read the overview, then press Next.",
    path: "/",
    target: { selector: ".panel-hero" },
  },
  {
    id: "phuong",
    title: "An invoice above its trip sheet",
    body: "Phuong asks for USD 960. The trip sheet says 4 vehicle-days at USD 200, so the check line breaks at Verified and nothing is paid.",
    doThis: "Press Correct to USD 800.00. The request is checked again and waits for a person to approve.",
    path: "/obligations/:phuong",
    target: { selector: "button", text: "Correct to" },
  },
  {
    id: "duplicate",
    title: "A job PayPal already paid",
    body: "Maria invoices JOB-HG4D-0914 again. It was paid 17 days ago, and PayPal's own record of that payout blocks it too, with the PayPal transaction id.",
    doThis: "Press Cancel request. No money moves.",
    path: "/obligations/:duplicate",
    target: { selector: '[aria-label="Decision"]' },
  },
  {
    id: "paypal",
    title: "The rules pass it, a person pays",
    body: "USD 180 for JOB-HG4D-0921 matches its trip sheet and is under the USD 250 line, so every rule passes, including no earlier payment for this job here or in PayPal's own records (simulated in this demo). The recorded Claude run raised a possible duplicate at 25% confidence from a live sandbox payment the rules do not see, so the card shows it and you decide.",
    doThis: "Read the concern on the card, then press Pay with PayPal and watch the track move to Paid.",
    path: "/obligations/:paypal",
    target: { selector: "button", text: "Pay with PayPal" },
  },
  {
    id: "autopilot",
    title: "Autopilot, with a cancel window",
    body: "Rosa's USD 190 trip sheet comes in, confirmed by her rate card and departure. On Autopilot the agent schedules it, and anyone can cancel until the ring runs out: the window is shortened for this demo.",
    doThis: "Press Turn on Autopilot, then watch the ring. Cancel stops the payment. Do step 4 first: the tour will not let Autopilot send Maria's USD 180.",
    path: "/",
    target: { selector: 'section[aria-label="Autonomy"]' },
    action: { kind: "autopilot", label: "Turn on Autopilot", busy: "Turning on" },
  },
  {
    id: "agents",
    title: "Agents ask first",
    body: "Any AI agent can ask Checkrail over MCP before it pays a supplier, and gets pay, hold or block with the rule that decided. A check pays and saves nothing.",
    doThis: "Press Have a demo agent ask. A demo agent asks about Maria's duplicate, and its row lands in Recent questions.",
    path: "/agents",
    target: { selector: "section", text: "Recent questions" },
    action: { kind: "demo-agent", label: "Have a demo agent ask", busy: "Asking" },
  },
  {
    id: "getting-started",
    title: "Getting started",
    body: "Before going live, Checkrail re-checks 90 days of past bank payments and lists every call for you to mark. Your marks suggest changes: Dao Mountain Lodge has no rate card.",
    doThis: "Apply the Dao Mountain Lodge rate card, then open Your first weeks: the readiness gauge reaches 4 of 4.",
    path: "/onboarding/calibrate",
    target: { selector: "li", text: "Dao Mountain Lodge" },
    alsoOn: [{ path: "/onboarding/dashboard", target: { selector: ".cr-gauge" } }, { path: "/onboarding" }],
    link: { href: "/onboarding/dashboard", label: "Open Your first weeks" },
  },
  {
    id: "close",
    title: "Daily close and sign off",
    body: "The Daily close lists what needs a look first, then what the agent sent apart from what people sent, and spend against the cap.",
    doThis: "Read it, then press Sign off. It records exactly what was on the page.",
    path: "/close",
    target: { selector: "button", text: "Sign off" },
  },
];

export const TOUR_TOTAL = TOUR_STEPS.length;

/** The closing card, shown once after the last step. */
export function finale(sandbox: boolean): { title: string; body: string } {
  return {
    title: "Now explore on your own",
    body: sandbox
      ? "This copy of the demo is yours: nobody else sees your clicks. Try the documents on the Demo guide, switch role in the sidebar, or press Start over for a clean copy."
      : "Try the documents on the Demo guide or switch role in the sidebar. This demo is shared, so Reset demo puts the opening requests back for everyone.",
  };
}

/** A path with its seeded ids filled in, or null when one is missing (the story is not loaded). */
export function resolvePath(path: string, ids: TourIds): string | null {
  let missing = false;
  const out = path.replace(/:(phuong|duplicate|paypal)\b/g, (_, k: keyof TourIds) => {
    const id = ids[k];
    if (!id) missing = true;
    return id ? encodeURIComponent(id) : "";
  });
  return missing ? null : out;
}

/** Where a step lives, and what it highlights there, for this pathname. Null when the step is not on this page. */
export function stepOnPage(step: TourStep, pathname: string, ids: TourIds): { target?: TourTarget } | null {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const here = strip(pathname);
  if (resolvePath(step.path, ids) === here) return { target: step.target };
  for (const also of step.alsoOn ?? []) if (resolvePath(also.path, ids) === here) return { target: also.target };
  return null;
}

/**
 * Progress, kept in a cookie per visitor: not started or skipped, at a step, or finished. A step carries the copy of
 * the demo it was taken in (`copy`, see copyStamp), so a tour that outlives its copy (Start over, or a copy deleted
 * after a while idle) is noticed instead of continuing into steps whose earlier clicks are gone.
 */
export type TourState = { status: "off" } | { status: "on"; index: number; copy?: string } | { status: "done" };

export const TOUR_COOKIE = "checkrail_tour";

/** A short cookie-safe stamp for one copy of the demo: when it was made, and when the demo inside it was seeded. */
export function copyStamp(copiedAtMs: number | null, seededAtIso: string | null | undefined): string | null {
  const seeded = seededAtIso ? Date.parse(seededAtIso) : NaN;
  const parts = [copiedAtMs, Number.isFinite(seeded) ? seeded : null].filter((x): x is number => typeof x === "number" && x > 0);
  return parts.length ? parts.map((x) => Math.floor(x).toString(36)).join("") : null;
}

export function parseTourCookie(value: string | null | undefined): TourState {
  if (value === "done") return { status: "done" };
  const m = value ? /^(\d{1,2})(?:\.([a-z0-9]{1,30}))?$/.exec(value) : null;
  if (m) {
    const index = Number(m[1]);
    if (index < TOUR_TOTAL) return m[2] ? { status: "on", index, copy: m[2] } : { status: "on", index };
    if (index === TOUR_TOTAL) return { status: "done" };
  }
  return { status: "off" };
}

export function tourCookieValue(state: TourState): string {
  if (state.status !== "on") return state.status;
  return state.copy ? `${state.index}.${state.copy}` : String(state.index);
}

/** Next from the last step finishes the tour; Back from the first stays put. The copy goes along. */
export function move(state: TourState, delta: 1 | -1): TourState {
  if (state.status !== "on") return state;
  const index = state.index + delta;
  if (index >= TOUR_TOTAL) return { status: "done" };
  return { ...state, index: Math.max(0, index) };
}

/**
 * The tour is past step 1 but its copy of the demo is not the one in use now: the earlier steps' clicks are gone,
 * so it offers to start again rather than carry on.
 */
export function outlivedCopy(state: TourState, current: string | null): boolean {
  return state.status === "on" && state.index > 0 && Boolean(state.copy) && Boolean(current) && state.copy !== current;
}

export function progressLabel(index: number): string {
  return `Step ${index + 1} of ${TOUR_TOTAL}`;
}

/** The label on the forward button. */
export function nextLabel(index: number): string {
  return index === TOUR_TOTAL - 1 ? "Finish" : "Next";
}
