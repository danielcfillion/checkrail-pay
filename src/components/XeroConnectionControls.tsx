"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { XeroCardView, XeroMappingInput } from "@/lib/accounting/xeroSettings";
import { ConfirmButton } from "./ConfirmButton";
import { useToast } from "./Toast";

/** What came back from Xero's sign-in, in words (the callback puts one of these on the Settings URL). */
const OUTCOME: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Connected to Xero. Check the accounts below, then save." },
  denied: { ok: false, text: "Xero was not connected: access was not allowed on Xero's screen." },
  expired: { ok: false, text: "That Xero sign-in took too long. Press Connect to Xero again." },
  invalid_state: { ok: false, text: "That Xero sign-in could not be matched to you. Press Connect to Xero again." },
  failed: { ok: false, text: "Xero did not finish the connection. Try again, and check the client id, secret and redirect URI." },
  not_configured: { ok: false, text: "Xero is not set up on this server yet." },
  no_data_key: { ok: false, text: "Set CHECKRAIL_DATA_KEY on the server before connecting Xero." },
};

type Result = { ok: boolean; message: string };

async function call(url: string, method: "POST" | "DELETE", body?: unknown): Promise<Result> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as Result;
    return { ok: res.ok, message: (await res.text()) || `HTTP ${res.status}` };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

const FIELDS: Array<{ key: keyof XeroMappingInput; label: string; list: "expense" | "bank" | "tax" | "withholding"; hint: string }> = [
  { key: "expenseAccountCode", label: "Supplier bills", list: "expense", hint: "Used when a bill's own account (310, 325, 400, 429) is not in your chart." },
  { key: "paypalAccountCode", label: "PayPal clearing", list: "bank", hint: "Bank account PayPal payments come out of." },
  { key: "stellarAccountCode", label: "Stellar treasury", list: "bank", hint: "Bank account for the PYUSD treasury." },
  { key: "bankAccountCode", label: "Wise and bank file", list: "bank", hint: "Bank account local payouts come out of." },
  { key: "feeAccountCode", label: "Payment fees", list: "expense", hint: "PayPal, Wise and bank fees." },
  { key: "withholdingAccountCode", label: "Tax withheld", list: "withholding", hint: "Liability account the withheld part is paid from. Tick Enable payments to this account on it in Xero." },
  { key: "taxType", label: "Tax rate on bills", list: "tax", hint: "Default tax rate on each bill line." },
];

export function XeroConnectionControls({ view, owner, mayPush }: { view: XeroCardView; owner: boolean; mayPush: boolean }) {
  const [mapping, setMapping] = useState<XeroMappingInput>(view.mapping);
  const [busy, start] = useTransition();
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  const { toast } = useToast();

  // The sign-in outcome arrives as ?xero=... on Settings. Show it once, then tidy the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const o = url.searchParams.get("xero");
    if (!o) return;
    setOutcome(OUTCOME[o] ?? null);
    url.searchParams.delete("xero");
    window.history.replaceState(null, "", url.toString());
  }, []);

  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      toast(r.message, r.ok ? "ok" : "error");
      router.refresh();
    });

  const options = (list: "expense" | "bank" | "tax" | "withholding") => (list === "tax" ? view.taxRates.map((t) => ({ value: t.type, label: t.name })) : (list === "bank" ? view.bankAccounts : list === "withholding" ? view.withholdingAccounts : view.expenseAccounts).map((a) => ({ value: a.code, label: a.label })));
  const changed = FIELDS.some((f) => (mapping[f.key] ?? "") !== (view.mapping[f.key] ?? ""));

  return (
    <div className="space-y-4">
      {outcome ? (
        <p className={`rounded border px-3 py-2 text-sm text-ink ${outcome.ok ? "border-settled bg-settled-soft" : "border-attention bg-attention-soft"}`} role="status">
          {outcome.text}
        </p>
      ) : null}

      {!view.connected || view.needsReconnect ? (
        owner ? (
          <div className="flex flex-wrap items-center gap-3">
            {view.dataKeyMissing ? (
              <button type="button" className="btn btn-primary" disabled>
                Connect to Xero
              </button>
            ) : (
              <a href="/api/xero/connect" className="btn btn-primary">
                {view.needsReconnect ? "Connect to Xero again" : "Connect to Xero"}
              </a>
            )}
            <span className="text-sm text-ink-soft">You sign in at Xero and pick the organisation. Checkrail never sees your Xero password.</span>
          </div>
        ) : (
          <p className="text-ink-soft">Only the owner connects Xero.</p>
        )
      ) : null}

      {view.connected ? (
        <>
          <div className="border-t pt-4 hairline">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Accounts</h3>
              {owner ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => call("/api/xero/accounts", "POST"))}>
                  {view.chartFetchedAt ? "Read accounts again" : "Read accounts from Xero"}
                </button>
              ) : null}
            </div>
            {view.chartFetchedAt ? (
              <>
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <div key={f.key} className="min-w-0">
                      <label className="lbl" htmlFor={`xero-${f.key}`}>
                        {f.label}
                      </label>
                      <select id={`xero-${f.key}`} className="field" value={mapping[f.key] ?? ""} disabled={!owner || busy} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || null })}>
                        <option value="">Not chosen</option>
                        {options(f.list).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-ink-soft">{f.hint}</p>
                    </div>
                  ))}
                </div>
                {owner ? (
                  <button type="button" className="btn btn-primary btn-sm mt-3" disabled={busy || !changed} onClick={() => run(() => call("/api/xero/mapping", "POST", mapping))}>
                    {busy ? "Saving" : "Save accounts"}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-ink-soft">The chart of accounts has not been read yet.</p>
            )}
          </div>

          <div className="border-t pt-4 hairline">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Sending</h3>
              {mayPush ? (
                <button type="button" className="btn btn-sm" disabled={busy || view.destination !== "xero"} onClick={() => run(() => call("/api/xero/push", "POST"))}>
                  {busy ? "Sending" : "Push to Xero"}
                </button>
              ) : null}
            </div>
            <p className="text-sm text-ink-soft">Bills go when they are approved; the payment and its fee go when the payment settles. Anything that cannot be sent is tried again every few minutes, or now with Push to Xero.</p>
            {view.failures.length ? (
              <ul className="mt-3 space-y-2">
                {view.failures.map((f) => (
                  <li key={f.id} className="rounded border border-blocked bg-blocked-soft px-3 py-2 text-sm">
                    <span className="font-medium">{f.label}</span>
                    <span className="block text-ink">{f.error}</span>
                    <span className="block text-xs text-ink-soft">{f.needsPerson ? "Needs a person in Xero: not tried again" : `${f.attempts} ${f.attempts === 1 ? "try" : "tries"}`}</span>
                  </li>
                ))}
              </ul>
            ) : view.lastError ? (
              <p className="mt-3 text-sm text-attention">{view.lastError}</p>
            ) : null}
          </div>

          {owner ? (
            <div className="border-t pt-4 hairline">
              <ConfirmButton
                label="Disconnect Xero"
                busyLabel="Disconnecting"
                tone="danger"
                size="sm"
                confirmText="Checkrail stops sending to Xero and forgets the connection. What is already in Xero stays there."
                action={async () => {
                  const r = await call("/api/xero/connection", "DELETE");
                  return r.ok ? { ok: true, message: r.message } : { ok: false, message: r.message };
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
