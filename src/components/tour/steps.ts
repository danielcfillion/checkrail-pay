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
    title: "A clean one, paid over PayPal",
    body: "USD 180 for JOB-HG4D-0921 matches its trip sheet and is under the USD 250 line, so the rules pass it. PayPal is simulated in this demo.",
    doThis: "Press Pay with PayPal and watch the track move to Paid.",
    path: "/obligations/:paypal",
    target: { selector: "button", text: "Pay with PayPal" },
  },
  {
    id: "autopilot",
    title: "Autopilot, with a cancel window",
    body: "Rosa's USD 190 trip sheet comes in, confirmed by her rate card and departure. On Autopilot the agent schedules it, and anyone can cancel until the ring runs out: the window is shortened for this demo.",
    doThis: "Press Turn on Autopilot, then watch the ring. Cancel stops the payment.",
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

/** Progress, kept in a cookie per visitor: not started or skipped, at a step, or finished. */
export type TourState = { status: "off" } | { status: "on"; index: number } | { status: "done" };

export const TOUR_COOKIE = "checkrail_tour";

export function parseTourCookie(value: string | null | undefined): TourState {
  if (value === "done") return { status: "done" };
  if (value && /^\d{1,2}$/.test(value)) {
    const index = Number(value);
    if (index >= 0 && index < TOUR_TOTAL) return { status: "on", index };
    if (index === TOUR_TOTAL) return { status: "done" };
  }
  return { status: "off" };
}

export function tourCookieValue(state: TourState): string {
  return state.status === "on" ? String(state.index) : state.status;
}

/** Next from the last step finishes the tour; Back from the first stays put. */
export function move(state: TourState, delta: 1 | -1): TourState {
  if (state.status !== "on") return state;
  const index = state.index + delta;
  if (index >= TOUR_TOTAL) return { status: "done" };
  return { status: "on", index: Math.max(0, index) };
}

export function progressLabel(index: number): string {
  return `Step ${index + 1} of ${TOUR_TOTAL}`;
}

/** The label on the forward button. */
export function nextLabel(index: number): string {
  return index === TOUR_TOTAL - 1 ? "Finish" : "Next";
}
