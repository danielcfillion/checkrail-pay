"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { createImportAction, detectColumnsAction } from "@/app/onboarding/actions";
import { FileDrop } from "@/components/FileDrop";
import { useToast } from "@/components/Toast";
import { formatMoney, pluralise } from "@/lib/format";
import type { Detection, Field, ImportSpec } from "@/lib/onboarding/detect";
import type { ImportSummary } from "@/lib/onboarding/imports";
import { DATE_ORDER_LABEL, MAP_FIELDS, confidenceWord, estimateSeconds, guessCurrency, missingFields, previewRows, setColumn, sharedColumns, shortDate, unmappedColumns } from "./import-model";

const MAX_BYTES = 5 * 1024 * 1024;

type Phase = "idle" | "reading" | "mapping" | "running" | "done";

/**
 * Screen 1's main block: pick a bank export, confirm how its columns read, then re-check its last 90 days. The server
 * reads the file again with the confirmed mapping; nothing here can pay, and payout details are never read.
 */
export function BankImport({ canIngest, currencies, baseCurrency }: { canIngest: boolean; currencies: readonly string[]; baseCurrency: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [spec, setSpec] = useState<ImportSpec | null>(null);
  const [currency, setCurrency] = useState(baseCurrency);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (phase !== "running") return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const reset = () => {
    setPhase("idle");
    setFile(null);
    setDetection(null);
    setSpec(null);
    setError(null);
    setResult(null);
  };

  const onFiles = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setError(null);
    setResult(null);
    if (f.size > MAX_BYTES) {
      setError("That file is larger than 5 MB. Export a shorter period.");
      setPhase(detection ? "mapping" : "idle");
      return;
    }
    setPhase("reading");
    const text = await f.text();
    const res = await detectColumnsAction(text);
    if (!res.ok) {
      setError(res.message);
      toast(res.message, "error");
      setPhase("idle");
      return;
    }
    setFile({ name: f.name, text });
    setDetection(res.data);
    setSpec(res.data.spec);
    setCurrency(guessCurrency(res.data.header, res.data.sample, currencies, baseCurrency));
    setPhase("mapping");
  };

  const run = async () => {
    if (!file || !spec) return;
    setError(null);
    setPhase("running");
    const res = await createImportAction({ csv: file.text, fileName: file.name, currency, spec });
    if (!res.ok) {
      setError(res.message);
      toast(res.message, "error");
      setPhase("mapping");
      return;
    }
    setResult(res.data);
    setPhase("done");
    toast(`Re-checked ${pluralise(res.data.payments, "payment")} from ${shortDate(res.data.periodFrom)} to ${shortDate(res.data.periodTo)}.`);
    router.refresh();
  };

  if (phase === "done" && result) return <ImportResult summary={result} onAnother={reset} />;

  const missing = spec ? missingFields(spec) : [];
  const shared = spec ? sharedColumns(spec) : [];
  const running = phase === "running";
  const ready = phase === "mapping" && spec !== null && missing.length === 0 && canIngest;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="panel min-w-0 p-6" aria-labelledby="bank-file-title">
        <h2 id="bank-file-title" className="text-lg font-semibold">
          Past bank payments
        </h2>
        <p className="mt-1 max-w-2xl text-ink-soft">Your bank&apos;s CSV export of the last few months. Checkrail guesses which column is which; check its guess before the re-check runs.</p>
        <div className="mt-5">
          <FileDrop
            accept=".csv,text/csv,text/plain"
            label="Drop your bank's CSV export, or choose a file"
            hint="CSV up to 5 MB. Commas, semicolons or tabs all work."
            disabled={!canIngest || running}
            busy={phase === "reading" ? "Reading the columns" : null}
            onFiles={onFiles}
          />
        </div>
        {!canIngest ? <p className="dense mt-3 text-ink-soft">An AP clerk or the owner brings in past payments.</p> : null}
        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-blocked-soft px-3 py-2 text-blocked">
            {error}
          </p>
        ) : null}
        <p className="mt-4 flex items-start gap-2 text-ink-soft">
          <LockIcon />
          <span>Payout details are never imported. Money only goes to account details a second person verified on the supplier page.</span>
        </p>

        {detection && spec ? <Mapper detection={detection} spec={spec} onSpec={setSpec} currency={currency} currencies={currencies} onCurrency={setCurrency} disabled={running || !canIngest} /> : null}
      </section>

      <aside className="panel h-fit min-w-0 p-6 lg:sticky lg:top-6" aria-labelledby="found-title">
        <h2 id="found-title" className="text-lg font-semibold">
          {detection ? "What we found" : "What happens"}
        </h2>
        {detection && spec ? (
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
            <dt className="text-ink-soft">File</dt>
            <dd className="mono min-w-0 truncate text-right text-[13px]" title={file?.name}>
              {file?.name}
            </dd>
            <dt className="text-ink-soft">Rows</dt>
            <dd className="num text-right font-medium">{detection.dataRows}</dd>
            <dt className="text-ink-soft">Currency</dt>
            <dd className="text-right font-medium">{currency}</dd>
            <dt className="text-ink-soft">Columns</dt>
            <dd className={`text-right font-medium ${missing.length ? "text-attention" : ""}`}>{missing.length ? `${missing.length} to choose` : "All set"}</dd>
            <dt className="text-ink-soft">Layout</dt>
            <dd className="text-right font-medium">{detection.fromSaved ? "Saved last time" : "New"}</dd>
          </dl>
        ) : (
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-ink-soft">
            <li>Pick your bank export.</li>
            <li>Check which column is which.</li>
            <li>Checkrail re-checks the last 90 days as if each payment were asked for that day.</li>
          </ol>
        )}

        {running ? (
          <RunProgress rows={detection?.dataRows ?? 0} elapsed={elapsed} />
        ) : (
          <>
            <button type="button" className="btn btn-primary mt-5 w-full justify-center" disabled={!ready} onClick={run}>
              Re-check 90 days
            </button>
            {phase === "mapping" && missing.length ? <p className="dense mt-2 text-attention">Choose the column for: {missing.map(fieldLabel).join(", ")}.</p> : null}
            {phase === "mapping" && !missing.length && shared.length ? <p className="dense mt-2 text-attention">Two fields read the same column. Check the mapping.</p> : null}
          </>
        )}
        <p className="dense mt-4 text-ink-soft">The re-check runs on a throwaway copy. Your books, suppliers and rules are not changed, and nothing is paid.</p>
      </aside>
    </div>
  );
}

const fieldLabel = (f: Field) => MAP_FIELDS.find((m) => m.key === f)?.label ?? f;

function RunProgress({ rows, elapsed }: { rows: number; elapsed: number }) {
  const est = estimateSeconds(rows);
  return (
    <div className="mt-5" aria-live="polite">
      <p className="font-medium">Re-checking {pluralise(rows, "row")}</p>
      <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-paper" role="progressbar" aria-label="Re-check running" aria-valuetext={`${elapsed} seconds so far`}>
        <span className="filedrop-bar block h-full w-1/3 rounded-full" style={{ background: "var(--ink)" }} />
      </span>
      <p className="dense mt-2 text-ink-soft">
        <span className="num">{elapsed}</span> s so far, about <span className="num">{est}</span> s in all. A file of 1,000 payments takes up to 40 seconds. Keep this page open.
      </p>
    </div>
  );
}

function Mapper({ detection, spec, onSpec, currency, currencies, onCurrency, disabled }: { detection: Detection; spec: ImportSpec; onSpec: (s: ImportSpec) => void; currency: string; currencies: readonly string[]; onCurrency: (c: string) => void; disabled: boolean }) {
  const id = useId();
  const preview = useMemo(() => previewRows(detection.header, detection.sample, spec), [detection, spec]);
  const unmapped = unmappedColumns(detection.header, spec);
  const pct = Math.round(detection.confidence * 100);
  const first = preview.find((r) => r.payment) ?? preview[0];
  const firstValue: Record<Field, string | undefined> = { date: first?.dateRaw, payee: first?.payee, amount: first?.amount, reference: first?.reference, description: first?.description };
  const dateNote = detection.fromSaved ? "From the layout saved last time." : detection.dateOrderCertain ? "Settled by the file: a day over 12 shows which number is the day." : "No date in the file says which way round it is. Check the dates below.";

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">Match the columns</h3>
        <p className="dense text-ink-soft">
          {detection.fromSaved ? (
            "Mapped from the layout you saved last time"
          ) : (
            <>
              Confidence <span className="num">{pct}%</span>, {confidenceWord(detection.confidence)}
            </>
          )}
        </p>
      </div>
      <p className="mt-1 text-ink-soft">Change any guess. Nothing is saved until you run the re-check.</p>

      <div className="mt-4 overflow-x-auto rounded-xl bg-paper/60">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Checkrail needs</th>
              <th scope="col">Column in your file</th>
              <th scope="col">First payment reads</th>
            </tr>
          </thead>
          <tbody>
            {MAP_FIELDS.map((f, i) => {
              const value = (spec.columns[f.key] as string | undefined) ?? "";
              const missingHere = f.required && !value && !(f.key === "payee" && spec.payeePattern);
              return (
                <tr key={f.key}>
                  <th scope="row" className="!text-[14px] !font-medium !text-ink" style={i === MAP_FIELDS.length - 1 ? { borderBottom: "none" } : undefined}>
                    <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
                    <span className="dense block font-normal text-ink-soft">
                      {f.help}
                      {f.required ? "" : ", optional"}
                    </span>
                  </th>
                  <td className="w-[240px]">
                    <select id={`${id}-${f.key}`} className="field" value={value} disabled={disabled} aria-invalid={missingHere || undefined} onChange={(e) => onSpec(setColumn(spec, f.key, e.target.value))} style={missingHere ? { borderColor: "var(--attention)" } : undefined}>
                      <option value="">{f.required ? "Choose a column" : "Not in this file"}</option>
                      {detection.header.filter(Boolean).map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="min-w-0 max-w-[260px] text-ink-soft">
                    {value ? (
                      <span className={`block truncate ${f.key === "reference" ? "mono text-[13px]" : ""} ${f.key === "amount" ? "num" : ""}`} title={firstValue[f.key]}>
                        {firstValue[f.key] || "empty"}
                        {f.key === "date" && first?.date ? <span className="text-ink"> = {shortDate(first.date)}</span> : null}
                        {f.key === "amount" && first?.payment ? <span className="text-ink"> {currency}</span> : null}
                      </span>
                    ) : missingHere ? (
                      <span className="text-attention">Choose one</span>
                    ) : (
                      "not read"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="lbl" htmlFor={`${id}-order`}>
            Date order
          </label>
          <select id={`${id}-order`} className="field" value={spec.dateFormat} disabled={disabled} onChange={(e) => onSpec({ ...spec, dateFormat: e.target.value as ImportSpec["dateFormat"] })}>
            {(Object.keys(DATE_ORDER_LABEL) as Array<ImportSpec["dateFormat"]>).map((k) => (
              <option key={k} value={k}>
                {DATE_ORDER_LABEL[k]}
              </option>
            ))}
          </select>
          <p className={`dense mt-1.5 ${detection.dateOrderCertain || detection.fromSaved ? "text-ink-soft" : "text-attention"}`}>{dateNote}</p>
        </div>
        <div>
          <label className="lbl" htmlFor={`${id}-currency`}>
            Currency of the amounts
          </label>
          <select id={`${id}-currency`} className="field" value={currency} disabled={disabled} onChange={(e) => onCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <p className="dense mt-1.5 text-ink-soft">Guessed from the headers. One currency per file.</p>
        </div>
      </div>

      {unmapped.length ? (
        <p className="mt-4 text-ink-soft">
          <span className="font-medium text-ink">Not read: </span>
          {unmapped.map((h, i) => (
            <span key={h}>
              {i ? ", " : ""}
              {h}
              {h === detection.creditColumn ? " (money in, not a supplier payment)" : ""}
            </span>
          ))}
          .
        </p>
      ) : null}

      <details className="mt-5" open>
        <summary>The first rows as this mapping reads them</summary>
        <p className="dense mt-2 text-ink-soft">Account numbers, phone numbers and emails are taken out before anything is shown.</p>
        <div className="mt-2 overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Payee</th>
                <th scope="col" className="r">
                  Amount
                </th>
                <th scope="col">Reference</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i} className={r.payment ? "" : "text-ink-soft"}>
                  <td className="whitespace-nowrap">{r.date ? shortDate(r.date) : <span className="text-attention">{r.dateRaw ? `${r.dateRaw}, does not read` : "no date"}</span>}</td>
                  <td className="max-w-[180px] truncate">{r.payee || <span className="text-ink-soft">none</span>}</td>
                  <td className="r num whitespace-nowrap">{r.payment ? r.amount : <span className="text-ink-soft">money in, skipped</span>}</td>
                  <td className="mono whitespace-nowrap text-[13px]">{r.reference}</td>
                  <td className="max-w-[240px] truncate text-ink-soft" title={r.description}>
                    {r.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** The re-check's answer: the money that would have been stopped leads, then the counts, then how to check the calls. */
export function ImportResult({ summary: s, onAnother }: { summary: ImportSummary; onAnother?: () => void }) {
  return (
    <section aria-labelledby="result-title">
      <h2 id="result-title" className="text-lg font-semibold">
        Re-checked {pluralise(s.payments, "payment")} from {shortDate(s.periodFrom)} to {shortDate(s.periodTo)}
      </h2>
      <p className="mono mt-1 text-[13px] text-ink-soft">{s.fileName}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <ResultFigure hero label="Would have been stopped" value={formatMoney(s.wouldHaveBlockedMinor, s.currency)} note={`${pluralise(s.duplicates.count, "payment")} paid twice, ${pluralise(s.overcharges.count, "overcharge")}`} />
        <ResultFigure label="Blocked" value={String(s.blockedCount)} note="paid twice, over the job record, or another rule" tone={s.blockedCount ? "blocked" : undefined} />
        <ResultFigure label="Held for a person" value={String(s.heldCount)} note="your call: right catch or fine" tone={s.heldCount ? "attention" : undefined} />
        <ResultFigure label="Clear" value={String(s.clearCount)} note="every rule passed" tone={s.clearCount ? "settled" : undefined} />
      </dl>
      <div className="panel mt-4 flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <ul className="space-y-1">
          <li>
            <span className="font-medium">Paid twice:</span> {pluralise(s.duplicates.count, "payment")}, <span className="num">{formatMoney(s.duplicates.minor, s.currency)}</span>
          </li>
          <li>
            <span className="font-medium">More than the job record:</span> {pluralise(s.overcharges.count, "payment")}, <span className="num">{formatMoney(s.overcharges.overpaidMinor, s.currency)}</span> over
          </li>
          {s.skipped.length || s.rowsOutsideWindow ? (
            <li className="text-ink-soft">
              {s.skipped.length ? `${pluralise(s.skipped.length, "row")} could not be read. ` : ""}
              {s.rowsOutsideWindow ? `${pluralise(s.rowsOutsideWindow, "payment")} older than 90 days left out.` : ""}
            </li>
          ) : null}
        </ul>
        <div className="flex flex-wrap gap-2">
          {onAnother ? (
            <button type="button" className="btn" onClick={onAnother}>
              Bring in another file
            </button>
          ) : null}
          <Link href={`/onboarding/calibrate?import=${encodeURIComponent(s.id)}`} className="btn btn-primary">
            Check our calls
          </Link>
        </div>
      </div>
      {s.skipped.length ? (
        <details className="mt-3">
          <summary>Rows that could not be read</summary>
          <ul className="mt-2 space-y-1 text-ink-soft">
            {s.skipped.slice(0, 20).map((p) => (
              <li key={p.row}>
                Line <span className="num">{p.row}</span>: {p.problem}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ResultFigure({ label, value, note, tone, hero = false }: { label: string; value: string; note?: string; tone?: "attention" | "settled" | "blocked"; hero?: boolean }) {
  const colour = tone === "attention" ? "text-attention" : tone === "settled" ? "text-settled" : tone === "blocked" ? "text-blocked" : "";
  return (
    <div className={`panel min-w-0 px-5 py-4 sm:px-6 sm:py-5 ${hero ? "panel-hero" : ""}`}>
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1.5 break-words text-[24px] leading-[30px] sm:text-[28px] sm:leading-[34px] ${colour}`}>{value}</dd>
      {note ? <dd className="mt-1 text-[13px] leading-[18px] text-ink-soft">{note}</dd> : null}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className="mt-0.5 shrink-0">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}
