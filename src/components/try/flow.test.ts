import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AUTO_STEP_MS, AutoPlayer, TRY_STEPS, TRY_TOTAL, navigate, progressLabel, trapNext, type TryNav } from "./flow";
import { READER_NOTE, Spotlight, TryItYourself } from "./TryItYourself";
import { TRY_SAMPLES, composeRequest, editField, fieldsFor, parseAmountMinor, sampleById } from "./samples";

describe("step navigation", () => {
  it("walks the six clerk steps in order, with Back, Next and Exit", () => {
    expect(TRY_STEPS.map((s) => s.id)).toEqual(["request", "evidence", "submit", "decide", "pay", "books"]);
    let s: TryNav = navigate({ status: "off" }, { type: "start" });
    expect(s).toEqual({ status: "on", index: 0 });
    expect(navigate(s, { type: "back" })).toEqual({ status: "on", index: 0 }); // Back on the first step stays
    for (let i = 1; i < TRY_TOTAL; i++) {
      s = navigate(s, { type: "next" });
      expect(s).toEqual({ status: "on", index: i });
    }
    s = navigate(s, { type: "next" });
    expect(s).toEqual({ status: "done" });
    expect(navigate(s, { type: "back" })).toEqual({ status: "on", index: TRY_TOTAL - 1 });
    expect(navigate({ status: "on", index: 3 }, { type: "back" })).toEqual({ status: "on", index: 2 });
    expect(navigate({ status: "on", index: 3 }, { type: "exit" })).toEqual({ status: "off" });
    expect(navigate({ status: "off" }, { type: "go", index: 99 })).toEqual({ status: "on", index: TRY_TOTAL - 1 });
    expect(progressLabel(0)).toBe("Step 1 of 6");
  });

  it("every step names an element on the page and a note for the staff member", () => {
    for (const s of TRY_STEPS) {
      expect(s.note.length).toBeGreaterThan(20);
      expect(s.target).toMatch(/^[a-z]+$/);
    }
  });
});

describe("the judge's fields", () => {
  it("prefills each sample and rewrites the request text from the fields until the judge types in it", () => {
    const s = sampleById("overcharge")!;
    let f = fieldsFor(s);
    expect(f.text).toBe("Please pay Phuong Transport INV-2026-0171, USD 1,100. Van and driver for the Ha Giang loop HG-4D-1026. Needs it today for fuel.");
    f = editField(s, f, "amount", "800");
    expect(f.text).toContain("USD 800.");
    f = editField(s, f, "text", "My own words for Phuong, USD 950");
    f = editField(s, f, "amount", "700");
    expect(f.text).toBe("My own words for Phuong, USD 950");
    expect(composeRequest(s, { payee: "", amount: "12.5", reference: "" })).toMatch(/^Please pay the supplier, USD 12.50\./);
  });

  it("reads amounts the way people type them", () => {
    expect(parseAmountMinor("1,100")).toBe(110_000);
    expect(parseAmountMinor("800.5")).toBe(80_050);
    expect(parseAmountMinor("USD 190")).toBe(19_000);
    expect(parseAmountMinor("ten")).toBeNull();
    expect(parseAmountMinor("1.234")).toBeNull();
  });

  it("uses only invented names, no em dashes", () => {
    const all = JSON.stringify(TRY_SAMPLES) + JSON.stringify(TRY_STEPS) + READER_NOTE;
    expect(all).not.toMatch(/\u2014/);
    expect(READER_NOTE).toBe("On the live product Claude reads this; the demo uses the rule-based reader.");
  });
});

describe("auto mode timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("advances about every 4 seconds, and finishes when the steps run out", async () => {
    let at = 0;
    const states: string[] = [];
    const p = new AutoPlayer(() => ++at < TRY_TOTAL, (s) => states.push(s), AUTO_STEP_MS, () => Date.now());
    p.play();
    expect(at).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTO_STEP_MS - 1);
    expect(at).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toBe(1);
    await vi.advanceTimersByTimeAsync(AUTO_STEP_MS * 10);
    expect(at).toBe(TRY_TOTAL);
    expect(states).toEqual(["playing", "finished"]);
  });

  it("pauses and resumes with the time that was left", async () => {
    let at = 0;
    const p = new AutoPlayer(() => (++at, true), undefined, AUTO_STEP_MS, () => Date.now());
    p.play();
    await vi.advanceTimersByTimeAsync(3000);
    p.pause();
    expect(p.state).toBe("paused");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(at).toBe(0);
    p.play();
    expect(p.state).toBe("playing");
    await vi.advanceTimersByTimeAsync(999);
    expect(at).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toBe(1);
    p.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(at).toBe(1);
  });

  it("waits for a slow step before starting the next wait, so steps never overlap", async () => {
    let started = 0;
    let finished = 0;
    const p = new AutoPlayer(
      () =>
        new Promise<boolean>((done) => {
          started++;
          setTimeout(() => {
            finished++;
            done(true);
          }, 10_000);
        }),
      undefined,
      AUTO_STEP_MS,
      () => Date.now(),
    );
    p.play();
    await vi.advanceTimersByTimeAsync(AUTO_STEP_MS);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect([started, finished]).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect([started, finished]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(AUTO_STEP_MS - 1);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(2);
    p.stop();
  });
});

describe("the overlay's accessibility", () => {
  const noop = () => {};
  const markup = (index: number) => renderToStaticMarkup(createElement(Spotlight, { index, title: TRY_STEPS[index].title, note: TRY_STEPS[index].note, target: TRY_STEPS[index].target, auto: "idle", onBack: noop, onNext: noop, onExit: noop, onPlay: noop, onPause: noop }));

  it("is a labelled modal dialog with named controls and progress", () => {
    const html = markup(2);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="try-coach-title"/);
    expect(html).toMatch(/id="try-coach-title"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="try-coach-title"/i);
    expect(html).toMatch(/aria-describedby="try-coach-note"/);
    expect(html).toMatch(/id="try-coach-note"/);
    expect(html).toContain(">Submit and see the checks<");
    expect(html).toMatch(/aria-label="Exit the guide \(Escape\)"/);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="3"/);
    for (const label of [">Back<", ">Next<", ">Play<"]) expect(html).toContain(label);
    // The dimmed panels are decoration: hidden from assistive technology.
    expect(html).toMatch(/aria-hidden="true" data-try-dim/);
    // No em dashes in what it says.
    expect(html).not.toMatch(/\u2014/);
  });

  it("Back is off on the first step and Next reads Finish on the last", () => {
    expect(markup(0)).toMatch(/<button type="button" class="btn btn-sm" disabled="">Back<\/button>/);
    expect(markup(TRY_TOTAL - 1)).toContain(">Finish<");
  });

  it("traps focus: Tab wraps from the last element to the first, Shift+Tab the other way, and outside focus comes in", () => {
    expect(trapNext(4, 0, false)).toBe(1);
    expect(trapNext(4, 3, false)).toBe(0);
    expect(trapNext(4, 0, true)).toBe(3);
    expect(trapNext(4, -1, false)).toBe(0);
    expect(trapNext(4, -1, true)).toBe(3);
    expect(trapNext(0, -1, false)).toBe(-1);
  });

  it("the desk labels every field, says how the request is read, and starts on the sample", () => {
    const html = renderToStaticMarkup(createElement(TryItYourself, { initialSample: "overcharge", startGuided: false }));
    for (const id of ["try-payee", "try-amount", "try-reference", "try-text"]) expect(html).toMatch(new RegExp(`for="${id}"[\\s\\S]*id="${id}"`));
    expect(html).toContain(READER_NOTE);
    expect(html).toMatch(/aria-describedby="try-reader-note"/);
    expect(html).toContain('value="1100"');
    expect(html).toMatch(/role="radio" aria-checked="true"/);
    for (const t of TRY_STEPS) expect(html).toContain(`data-try="${t.target}"`);
  });
});
