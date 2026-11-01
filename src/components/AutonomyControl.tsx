"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pauseAutopilotAction, setAutonomyAction } from "@/app/actions";
import { useToast } from "./Toast";
import { cancelWindowMinutesField, cancelWindowText } from "./cancel-window";

type Level = "review" | "assist" | "autopilot";

export type AutonomyView = {
  level: Level;
  paused: boolean;
  perPaymentCapMinor: number;
  dailyCapMinor: number;
  cancelWindowSeconds: number;
  committed24hMinor: number;
  autoApproveMinor: number;
  dualApprovalMinor: number;
  symbol: string;
};

const WHO: Record<Level, [string, string, string]> = {
  review: ["Agent", "You", "You"],
  assist: ["Agent", "Agent", "You"],
  autopilot: ["Agent", "Agent", "Agent"],
};
const STEPS = ["Checks", "Approves", "Sends"];

const dollars = (minor: number) => (minor / 100).toFixed(minor % 100 === 0 ? 0 : 2);
const pretty = (minor: number) => (minor / 100).toLocaleString("en-US", { minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
const toMinor = (s: string) => Math.round(Number(s) * 100);

/**
 * The autonomy setting. Three levels, described by who does each step. Raising the level asks for
 * confirmation; lowering it and pausing take effect at once, because stopping should never be slow.
 */
export function AutonomyControl({ view }: { view: AutonomyView }) {
  const [level, setLevel] = useState<Level>(view.level);
  const [perPayment, setPerPayment] = useState(dollars(view.perPaymentCapMinor));
  const [daily, setDaily] = useState(dollars(view.dailyCapMinor));
  const [minutes, setMinutes] = useState(cancelWindowMinutesField(view.cancelWindowSeconds));
  const [arm, setArm] = useState(false);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const isNum = (v: string) => v.trim() !== "" && Number.isFinite(Number(v));
  const capsValid = isNum(perPayment) && isNum(daily) && isNum(minutes) && Number(perPayment) >= 1 && Number(daily) >= 1 && Number(perPayment) <= Number(daily) && Number(minutes) >= 1;
  const dirty = level !== view.level || toMinor(perPayment) !== view.perPaymentCapMinor || toMinor(daily) !== view.dailyCapMinor || Math.round(Number(minutes) * 60) !== view.cancelWindowSeconds;
  const raising = level === "autopilot" && view.level !== "autopilot";

  const save = () =>
    start(async () => {
      const r = await setAutonomyAction({ autonomy: level, autopilotPerPaymentCapMinor: toMinor(perPayment), autopilotDailyCapMinor: toMinor(daily), autopilotCancelWindowSeconds: Math.round(Number(minutes) * 60) });
      toast(r.message, r.ok ? "ok" : "error");
      setArm(false);
      router.refresh();
    });
  const pause = (paused: boolean) =>
    start(async () => {
      const r = await pauseAutopilotAction(paused);
      toast(r.message, r.ok ? "ok" : "error");
      router.refresh();
    });

  const describe: Record<Level, { name: string; body: string }> = {
    review: { name: "Review everything", body: "The agent reads, checks and routes each request. A person approves and sends every one." },
    assist: { name: "Assist", body: `Requests the rules pass, up to ${view.symbol}${pretty(view.autoApproveMinor)}, are approved for you. A person presses send.` },
    autopilot: { name: "Autopilot", body: "Requests the rules pass, within your caps, are sent by the agent after a cancel window. You read the daily close." },
  };

  return (
    <div>
      <div role="radiogroup" aria-label="Autonomy level" className="grid gap-3 md:grid-cols-3">
        {(Object.keys(describe) as Level[]).map((l) => {
          const on = level === l;
          return (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                setLevel(l);
                setArm(false);
              }}
              className={`rounded-md border p-3 text-left ${on ? "bg-sheet" : "hairline bg-paper/50 hover:bg-sheet"}`}
              style={on ? { borderColor: "var(--ink)", boxShadow: "inset 0 0 0 1px var(--ink)" } : undefined}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{describe[l].name}</span>
                {view.level === l ? <span className="dense text-ink-soft">{view.paused && l === "autopilot" ? "paused" : "current"}</span> : null}
              </span>
              <span className="mt-1 block text-ink-soft">{describe[l].body}</span>
              <span className="mt-3 grid grid-cols-3 gap-1" aria-label={STEPS.map((s, i) => `${s}: ${WHO[l][i]}`).join(", ")}>
                {STEPS.map((s, i) => {
                  const agent = WHO[l][i] === "Agent";
                  return (
                    <span key={s} className="rounded-sm px-1.5 py-1" style={{ background: agent ? "var(--settled-soft)" : "var(--attention-soft)" }}>
                      <span className="dense block text-ink-soft">{s}</span>
                      <span className="dense block" style={{ color: agent ? "var(--settled)" : "var(--attention)" }}>
                        {WHO[l][i]}
                      </span>
                    </span>
                  );
                })}
              </span>
            </button>
          );
        })}
      </div>

      {level === "autopilot" ? (
        <div className="mt-4 grid gap-4 border-t pt-4 hairline sm:grid-cols-3">
          <div>
            <label className="lbl" htmlFor="cap-payment">Most the agent may send in one payment</label>
            <div className="flex items-center gap-1.5">
              <span className="text-ink-soft">{view.symbol}</span>
              <input id="cap-payment" className="field num" inputMode="decimal" value={perPayment} onChange={(e) => setPerPayment(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="lbl" htmlFor="cap-daily">Most the agent may send in 24 hours</label>
            <div className="flex items-center gap-1.5">
              <span className="text-ink-soft">{view.symbol}</span>
              <input id="cap-daily" className="field num" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="lbl" htmlFor="cap-window">Time to cancel before money moves</label>
            <div className="flex items-center gap-1.5">
              <input id="cap-window" className="field num" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              <span className="text-ink-soft">minutes</span>
            </div>
            {view.cancelWindowSeconds < 60 ? <p className="mt-1 text-xs text-ink-soft">Now {cancelWindowText(view.cancelWindowSeconds)}. Saving sets at least 1 minute.</p> : null}
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-ink-soft">
        The same at every level: a request is stopped if the amount does not match the evidence, the job was already paid, the payout details changed, evidence is missing or the corridor is off. Payments above {view.symbol}
        {pretty(view.dualApprovalMinor)} always need two people. Autonomy removes the approval step and nothing else.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {arm ? (
          <>
            <span className="text-ink-soft">
              The agent will send up to {view.symbol}
              {pretty(toMinor(perPayment))} per payment and {view.symbol}
              {pretty(toMinor(daily))} a day without asking.
            </span>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={save}>
              {pending ? "Turning on" : "Yes, turn on autopilot"}
            </button>
            <button type="button" className="btn" disabled={pending} onClick={() => setArm(false)}>
              Keep as is
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!dirty || !capsValid || pending} onClick={() => (raising ? setArm(true) : save())}>
            {pending ? "Saving" : raising ? "Turn on autopilot" : "Save"}
          </button>
        )}
        {view.level === "autopilot" && !arm ? (
          <button type="button" className={`btn ${view.paused ? "" : "btn-danger"}`} disabled={pending} onClick={() => pause(!view.paused)}>
            {view.paused ? "Resume autopilot" : "Pause autopilot"}
          </button>
        ) : null}
        {!capsValid ? <span className="text-blocked">Caps must be at least 1.00, the per-payment cap no larger than the daily cap, and the cancel window at least 1 minute.</span> : null}
      </div>
    </div>
  );
}
