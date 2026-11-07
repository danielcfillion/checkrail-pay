/**
 * Try it yourself: the six steps a clerk takes, the navigation between them and the auto-play timer. Pure, so the
 * step navigation and the timer are unit-tested without a browser (flow.test.ts); TryItYourself.tsx renders them.
 */

export type TryStepId = "request" | "evidence" | "submit" | "decide" | "pay" | "books";

export interface TryStep {
  id: TryStepId;
  title: string;
  /** What a staff member does here, in one or two sentences. */
  note: string;
  /** The element the spotlight leaves lit: a data-try attribute on the page. */
  target: string;
}

export const TRY_STEPS: readonly TryStep[] = [
  { id: "request", title: "Write or paste the request", note: "A clerk pastes the message the supplier sent. Keep the sample or type your own payee, amount and reference: your figures go through the real checks.", target: "request" },
  { id: "evidence", title: "Attach the evidence", note: "The clerk attaches the document behind the request. The PDF reader takes the figures from it; nobody types them in.", target: "evidence" },
  { id: "submit", title: "Submit and see the checks", note: "Submitting runs every rule: the payee, the evidence, the rate card, earlier payments. A request that fails one is blocked with the reason.", target: "submit" },
  { id: "decide", title: "Approve, correct or reject", note: "A person decides what the rules left open. A blocked request is corrected or cancelled; one under the auto-approve line is approved by policy.", target: "decide" },
  { id: "pay", title: "Pay", note: "An approved payment is sent on PayPal rails. Here the rails are simulated: no money moves.", target: "pay" },
  { id: "books", title: "See it in the books", note: "A paid request becomes a bill and a payment for the accountant, and appears in the Daily close for sign-off.", target: "books" },
];

export const TRY_TOTAL = TRY_STEPS.length;

/** Milliseconds per step in auto mode. */
export const AUTO_STEP_MS = 4000;

export type TryNav = { status: "off" } | { status: "on"; index: number } | { status: "done" };

export type TryNavEvent = { type: "start" } | { type: "next" } | { type: "back" } | { type: "exit" } | { type: "go"; index: number };

/** Guided mode's Back, Next and Exit. Next on the last step finishes; Back on the first stays. */
export function navigate(s: TryNav, e: TryNavEvent): TryNav {
  switch (e.type) {
    case "start":
      return { status: "on", index: 0 };
    case "exit":
      return { status: "off" };
    case "go":
      return { status: "on", index: Math.max(0, Math.min(TRY_TOTAL - 1, Math.floor(e.index))) };
    case "next":
      if (s.status === "done") return s;
      if (s.status === "off") return { status: "on", index: 0 };
      return s.index + 1 >= TRY_TOTAL ? { status: "done" } : { status: "on", index: s.index + 1 };
    case "back":
      if (s.status === "done") return { status: "on", index: TRY_TOTAL - 1 };
      if (s.status === "off") return s;
      return { status: "on", index: Math.max(0, s.index - 1) };
  }
}

export function progressLabel(index: number): string {
  return `Step ${index + 1} of ${TRY_TOTAL}`;
}

/**
 * Auto mode: every `stepMs` it calls `step()`, which does the current step's work and moves on, and returns false when
 * there is nothing left. A step that takes time (a server action) is awaited before the next wait starts, so a slow
 * reply never overlaps the next step. Pause stops the clock and remembers how long was left; Resume waits only that.
 * A step that failed returns "pause": the player pauses there, so the error stays on screen until the judge resumes.
 */
export class AutoPlayer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private left: number;
  private busy = false;
  private stopped = true;
  state: "idle" | "playing" | "paused" | "finished" = "idle";

  constructor(
    private readonly step: () => Promise<boolean | "pause"> | boolean | "pause",
    private readonly onChange: (state: AutoPlayer["state"]) => void = () => {},
    private readonly stepMs: number = AUTO_STEP_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.left = stepMs;
  }

  play(): void {
    if (this.state === "playing") return;
    this.stopped = false;
    this.left = this.state === "paused" ? this.left : this.stepMs;
    this.set("playing");
    if (!this.busy) this.arm(this.left);
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.left = this.timer ? Math.max(0, this.dueAt - this.now()) : this.stepMs;
    this.clear();
    this.set("paused");
  }

  /** Exit, or the page going away. */
  stop(): void {
    this.stopped = true;
    this.clear();
    this.set("idle");
  }

  private set(s: AutoPlayer["state"]): void {
    if (this.state === s) return;
    this.state = s;
    this.onChange(s);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    this.clear();
    this.dueAt = this.now() + ms;
    this.timer = setTimeout(() => void this.fire(), ms);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    this.busy = true;
    let more: boolean | "pause" = false;
    try {
      more = await this.step();
    } catch {
      more = "pause";
    } finally {
      this.busy = false;
    }
    if (this.stopped) return;
    if (more === "pause") {
      this.left = this.stepMs;
      if (this.state === "playing") this.set("paused");
      return;
    }
    if (!more) {
      this.set("finished");
      return;
    }
    this.left = this.stepMs;
    if (this.state === "playing") this.arm(this.stepMs);
  }
}

/** Everything a keyboard can reach inside an element. */
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The focus trap: where Tab (or Shift+Tab) goes from `current` among the overlay's focusable elements, wrapping at
 * both ends. -1 (focus outside the overlay) goes to the first, or the last with Shift.
 */
export function trapNext(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}
