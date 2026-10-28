"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ingestAction, uploadEvidenceAction } from "@/app/actions";
import type { SourceType } from "@/lib/domain/types";
import { evidenceKindLabel } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { RequestDropzone } from "@/components/RequestDropzone";

type EvidenceRow = { kind: string; label: string; amount: string; currency: string; reference: string; excerpt: string; attachmentId?: string | null; readBy?: string | null; fileName?: string | null };

const KINDS = ["job_sheet", "invoice", "contract", "booking", "message", "photo"];
const SOURCE_TYPES: Array<{ value: SourceType; label: string }> = [
  { value: "invoice", label: "Invoice" },
  { value: "job_completion", label: "Job completion" },
  { value: "operator_instruction", label: "Operator instruction" },
  { value: "booking", label: "Booking" },
];

const blank = (): EvidenceRow => ({ kind: "job_sheet", label: "", amount: "", currency: "USD", reference: "", excerpt: "", attachmentId: null });

const EXAMPLES: Record<"clean" | "mismatch", { sourceType: SourceType; raw: string; evidence: EvidenceRow[] }> = {
  clean: {
    sourceType: "job_completion",
    raw: "Trip KAL-2D-1002 closed. Kalaw Trekking Collective, 4 porters 2 days, USD 420 (JOB-KAL2D-1002). Signed off by ops. Release payment.",
    evidence: [{ kind: "job_sheet", label: "Trip sheet KAL-2D-1002", amount: "420.00", currency: "USD", reference: "JOB-KAL2D-1002", excerpt: "Departure KAL-2D-1002, Kalaw Trekking Collective, 4 porters x 2 days at USD 52.50 = USD 420.00. Completed 2 Oct." }],
  },
  mismatch: {
    sourceType: "operator_instruction",
    raw: "Please pay Linh Family Homestay INV-2026-0161 today, USD 540 for the Du Gia stay (9 guests, 2 nights). They asked for it before the weekend.",
    evidence: [
      { kind: "booking", label: "Booking confirmation HG-4D-1001", amount: "324.00", currency: "USD", reference: "INV-2026-0161", excerpt: "Du Gia village, 9 guests x 2 nights x USD 18.00 including dinner = USD 324.00." },
      { kind: "contract", label: "Homestay agreement 2026 (Linh)", amount: "18.00", currency: "USD", reference: "AGR-LINH-2026", excerpt: "USD 18.00 per guest per night including dinner. No weekend surcharge." },
    ],
  },
};

export function NewObligationForm() {
  const [sourceType, setSourceType] = useState<SourceType>("invoice");
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<EvidenceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [reading, setReading] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const router = useRouter();
  const { toast } = useToast();

  const onFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploadNote(null);
    try {
      for (const f of files) {
        setReading(f.name);
        const fd = new FormData();
        fd.append("file", f);
        const res = await uploadEvidenceAction(fd);
        if (!res.ok || !res.upload) {
          setUploadNote(res.message);
          toast(res.message, "error");
          continue;
        }
        const u = res.upload;
        if (u.proposed.length === 0) {
          setUploadNote(u.note ?? `Nothing readable in ${u.name}.`);
          setRows((rs) => [...rs, { ...blank(), label: u.name, kind: /\.(png|jpe?g|webp|gif)$/i.test(u.name) ? "photo" : "invoice", attachmentId: u.attachmentId, readBy: "none", fileName: u.name }]);
          continue;
        }
        setRows((rs) => [
          ...rs,
          ...u.proposed.map((p) => ({
            kind: p.kind,
            label: p.label,
            amount: p.amountMinor != null ? (p.amountMinor / 100).toFixed(2) : "",
            currency: p.currency ?? "USD",
            reference: p.reference ?? "",
            excerpt: p.excerpt ?? "",
            attachmentId: u.attachmentId,
            readBy: u.reader,
            fileName: u.name,
          })),
        ]);
        setUploadNote(`${u.name}: read by ${u.reader === "claude" ? "Claude" : u.reader === "pdf-text" ? "the PDF text reader" : "the text reader"}. Check the figures; an edited figure counts as operator-supplied.`);
      }
    } finally {
      setReading(null);
    }
  };

  const load = (k: keyof typeof EXAMPLES) => {
    const ex = EXAMPLES[k];
    setSourceType(ex.sourceType);
    setRaw(ex.raw);
    setRows(ex.evidence.map((e) => ({ ...e })));
    setError(null);
  };

  const update = (i: number, patch: Partial<EvidenceRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!raw.trim()) {
      setError("Paste the request text first.");
      return;
    }
    setError(null);
    start(async () => {
      const result = await ingestAction({
        sourceType,
        rawInput: raw.trim(),
        evidence: rows
          .filter((r) => r.label.trim())
          .map((r) => ({
            kind: r.kind,
            label: r.label.trim(),
            amountMinor: r.amount.trim() ? Math.round(Number(r.amount.replace(/,/g, "")) * 100) : null,
            currency: r.amount.trim() ? r.currency.trim().toUpperCase() || "USD" : null,
            reference: r.reference.trim() || null,
            excerpt: r.excerpt.trim() || null,
            attachmentId: r.attachmentId ?? null,
          })),
      });
      if (result.ok && result.id) {
        toast("Request created. The agent has read it.");
        router.push(`/obligations/${result.id}`);
      } else {
        setError(result.message);
        toast(result.message, "error");
      }
    });
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <section className="panel p-4">
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <div>
              <label className="lbl" htmlFor="sourceType">
                Where it came from
              </label>
              <select id="sourceType" className="field" value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)}>
                {SOURCE_TYPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4">
            <label className="lbl" htmlFor="raw">
              The request, as it arrived
            </label>
            <textarea id="raw" className="field" rows={6} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste the invoice text, the chat message or the job-completion note. Names, amounts and references are read by the agent." required />
          </div>
        </section>

        <section className="panel">
          <div className="flex items-baseline justify-between border-b px-4 py-2.5 hairline">
            <h2 className="font-medium">Evidence</h2>
            <span className="dense text-ink-soft">{rows.length === 0 ? "none attached" : `${rows.length} attached`}</span>
          </div>
          <div className="space-y-4 p-4">
            <RequestDropzone onFiles={(fs) => void onFiles(fs)} reading={reading} note={uploadNote} accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain" />
            {rows.length === 0 ? <p className="text-ink-soft">Without evidence, policy holds the request. Add a job sheet, invoice, contract or booking, or type one in, so the amount can be checked.</p> : null}
            {rows.map((r, i) => (
              <fieldset key={i} className="rounded border p-3 hairline">
                <legend className="dense px-1 text-ink-soft">
                  Record {i + 1}
                  {r.fileName ? <span className="ml-2 font-normal">from {r.fileName}{r.readBy && r.readBy !== "none" ? ` (read by ${r.readBy === "claude" ? "Claude" : "text reader"})` : " (not readable here)"}</span> : null}
                </legend>
                <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
                  <div>
                    <label className="lbl" htmlFor={`kind-${i}`}>
                      Kind
                    </label>
                    <select id={`kind-${i}`} className="field" value={r.kind} onChange={(e) => update(i, { kind: e.target.value })}>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {evidenceKindLabel(k)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="lbl" htmlFor={`label-${i}`}>
                      Label
                    </label>
                    <input id={`label-${i}`} className="field" value={r.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Trip sheet HG-4D-0921" />
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_90px_1fr]">
                  <div>
                    <label className="lbl" htmlFor={`amount-${i}`}>
                      Amount it states
                    </label>
                    <input id={`amount-${i}`} className="field num" inputMode="decimal" value={r.amount} onChange={(e) => update(i, { amount: e.target.value })} placeholder="180.00" />
                  </div>
                  <div>
                    <label className="lbl" htmlFor={`currency-${i}`}>
                      Currency
                    </label>
                    <input id={`currency-${i}`} className="field" value={r.currency} onChange={(e) => update(i, { currency: e.target.value })} maxLength={3} />
                  </div>
                  <div>
                    <label className="lbl" htmlFor={`reference-${i}`}>
                      Reference
                    </label>
                    <input id={`reference-${i}`} className="field num" value={r.reference} onChange={(e) => update(i, { reference: e.target.value })} placeholder="JOB-HG4D-0921" />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="lbl" htmlFor={`excerpt-${i}`}>
                    Excerpt
                  </label>
                  <textarea id={`excerpt-${i}`} className="field" rows={2} value={r.excerpt} onChange={(e) => update(i, { excerpt: e.target.value })} placeholder="The line that states the amount, quoted." />
                </div>
                <div className="mt-3 flex justify-end">
                  <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                    Remove record
                  </button>
                </div>
              </fieldset>
            ))}
            <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, blank()])}>
              Add evidence record
            </button>
          </div>
        </section>

        {error ? (
          <p role="alert" className="text-blocked">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "Reading the request" : "Create request"}
          </button>
          <span className="text-ink-soft">Nothing is paid at this step. The agent proposes; policy decides; you approve.</span>
        </div>
      </div>

      <aside className="space-y-4">
        <section className="panel p-4">
          <h2 className="font-medium">Try an example</h2>
          <p className="mt-1 text-ink-soft">Two requests built from the Ridgeline roster. Load one, then create it.</p>
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" className="btn w-full min-w-0 justify-start py-1.5 text-left" style={{ height: "auto", minHeight: 32, whiteSpace: "normal" }} onClick={() => load("clean")}>
              Clean job completion, Kalaw Trekking Collective
            </button>
            <button type="button" className="btn w-full min-w-0 justify-start py-1.5 text-left" style={{ height: "auto", minHeight: 32, whiteSpace: "normal" }} onClick={() => load("mismatch")}>
              Mismatched amount, Linh Family Homestay
            </button>
          </div>
          <p className="mt-3 text-xs text-ink-soft">The clean one should verify and go straight to the ready-to-pay state. The mismatched one asks for USD 540 against a USD 324 booking, so policy blocks it.</p>
        </section>
        <section className="panel p-4">
          <h2 className="font-medium">What happens next</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-soft">
            <li>The agent reads the text and names the vendor, amount and reference.</li>
            <li>Policy checks the amount against the evidence and the approval thresholds.</li>
            <li>The router quotes PayPal and Stellar and picks one, with a reason.</li>
            <li>You approve, correct or pay from the request page.</li>
          </ol>
        </section>
      </aside>
    </form>
  );
}
