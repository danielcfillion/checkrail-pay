"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/CopyButton";
import { TOUCH_SM } from "@/components/RequestPanels";
import { useToast } from "@/components/Toast";
import { issueMandateAction, revokeMandateAction } from "./actions";

const ROLE_WORDS: Record<string, string> = { guide: "Guides", driver: "Drivers and transport", homestay: "Homestays", hotel: "Hotels", creator: "Creators" };

/** The owner issues a mandate: one agent, who it may pay, how much, for how long. */
export function IssueMandateForm({ agents, suppliers, roles, currencies }: { agents: string[]; suppliers: Array<{ id: string; name: string }>; roles: string[]; currencies: readonly string[] }) {
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [perPayment, setPerPayment] = useState("500");
  const [total, setTotal] = useState("2000");
  const [currency, setCurrency] = useState("USD");
  const [departures, setDepartures] = useState(true);
  const [note, setNote] = useState("");
  const [until, setUntil] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [token, setToken] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = () =>
    start(async () => {
      const r = await issueMandateAction({ agent, payees: picked, roles: kinds, perPayment, total, currency, purpose: departures ? "departures" : null, note, validUntil: until });
      if (!r.ok) return toast(r.message, "error");
      toast(r.message);
      setToken(r.token ?? null);
      router.refresh();
    });

  if (token)
    return (
      <div className="grid gap-2 text-sm">
        <p>Mandate issued. Give this to the agent with its key; it passes it as &quot;mandate&quot; on request_payment.</p>
        <p className="num flex items-start gap-1 break-all rounded bg-paper p-2 text-2xs leading-4">
          {token} <CopyButton value={token} label="Copy the mandate" />
        </p>
        <button type="button" className={`btn btn-sm justify-self-start ${TOUCH_SM}`} onClick={() => setToken(null)}>
          Issue another
        </button>
      </div>
    );

  return (
    <form
      className="grid gap-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div>
        <label className="lbl" htmlFor="mdt-agent">
          Agent key name
        </label>
        <input id="mdt-agent" className="field" list="mdt-agents" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="claude-desktop" maxLength={40} required />
        <datalist id="mdt-agents">
          {agents.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </div>
      <fieldset>
        <legend className="lbl">Kinds of supplier it may pay</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {roles.map((r) => (
            <label key={r} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={kinds.includes(r)} onChange={() => toggle(kinds, setKinds, r)} /> {ROLE_WORDS[r] ?? r}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="lbl">Or these suppliers</legend>
        <div className="grid max-h-28 gap-1 overflow-y-auto rounded border border-[color:var(--rule)] p-2">
          {suppliers.map((s) => (
            <label key={s.id} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(picked, setPicked, s.id)} /> {s.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_88px] gap-2">
        <div>
          <label className="lbl" htmlFor="mdt-per">
            Per payment
          </label>
          <input id="mdt-per" className="field num" inputMode="decimal" value={perPayment} onChange={(e) => setPerPayment(e.target.value)} required />
        </div>
        <div>
          <label className="lbl" htmlFor="mdt-total">
            Total
          </label>
          <input id="mdt-total" className="field num" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} required />
        </div>
        <div>
          <label className="lbl" htmlFor="mdt-cur">
            Currency
          </label>
          <select id="mdt-cur" className="field" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <label className="inline-flex items-start gap-1.5">
        <input type="checkbox" className="mt-0.5" checked={departures} onChange={(e) => setDepartures(e.target.checked)} /> Only for departures in the booking system, to suppliers serving them
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-2">
        <div>
          <label className="lbl" htmlFor="mdt-note">
            What it is for (optional)
          </label>
          <input id="mdt-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={160} placeholder="Ha Giang departures in November" />
        </div>
        <div>
          <label className="lbl" htmlFor="mdt-until">
            Valid until
          </label>
          <input id="mdt-until" type="date" className="field num" value={until} onChange={(e) => setUntil(e.target.value)} required />
        </div>
      </div>
      <p className="text-xs text-ink-soft">The mandate only narrows what the agent may ask for. Every request under it still goes through your rules, approval and autonomy setting.</p>
      <button type="submit" className={`btn btn-primary justify-self-start ${TOUCH_SM}`} disabled={pending}>
        {pending ? "Signing" : "Sign and issue"}
      </button>
    </form>
  );
}

/** Revoke a mandate: the agent can no longer request anything under it. Requests already made stay as they are. */
export function RevokeMandateButton({ id, agent }: { id: string; agent: string }) {
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  if (!asking)
    return (
      <button type="button" className={`btn btn-sm ${TOUCH_SM}`} onClick={() => setAsking(true)}>
        Revoke
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-soft">Revoke {agent}&apos;s mandate?</span>
      <button
        type="button"
        className={`btn btn-sm btn-danger ${TOUCH_SM}`}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await revokeMandateAction(id);
            toast(r.message, r.ok ? undefined : "error");
            setAsking(false);
            router.refresh();
          })
        }
      >
        {pending ? "Revoking" : "Yes, revoke"}
      </button>
      <button type="button" className={`btn btn-sm ${TOUCH_SM}`} onClick={() => setAsking(false)}>
        Keep it
      </button>
    </span>
  );
}
