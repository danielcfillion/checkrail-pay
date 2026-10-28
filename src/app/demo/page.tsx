import Link from "next/link";
import { findObligationsBySourceRef, getOverview } from "@/lib/queries";
import type { ObligationRow } from "@/lib/queries";
import { formatMoneySymbol } from "@/lib/format";
import { CheckLine } from "@/components/CheckLine";
import { ResetDemoButton } from "@/components/ResetDemoButton";
import { EmptyState, Money, PageHeader, RailTag, StatePill } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Demo guide" };

const STORY: Array<{ ref: string; title: string; line: string; pick: (rows: ObligationRow[]) => ObligationRow | undefined }> = [
  {
    ref: "INV-2026-0152",
    title: "A request for more than the evidence supports",
    line: "Phuong asks for $960 for a four-day van hire. The trip sheet says 4 times 200 is $800. Policy breaks the line at verified; nobody overpays.",
    pick: (rows) => rows.find((r) => r.sourceRef === "INV-2026-0152"),
  },
  {
    ref: "JOB-HG4D-0914",
    title: "An invoice for a job already paid",
    line: "Maria's invoice for JOB-HG4D-0914 looks fine on its own. The duplicate check finds it was settled on 16 September, so it stops.",
    pick: (rows) => rows.filter((r) => r.sourceRef === "JOB-HG4D-0914").find((r) => r.state !== "settled") ?? rows.find((r) => r.sourceRef === "JOB-HG4D-0914"),
  },
  {
    ref: "JOB-HG4D-0921",
    title: "A clean one, paid over PayPal",
    line: "Under the $250 threshold and matching its trip sheet, this cleared on its own. Both rails cost the same within a fraction of a percent at this size, so the router takes PayPal, whose whole path runs end to end today. Pay, and watch the marker travel.",
    pick: (rows) => rows.find((r) => r.sourceRef === "JOB-HG4D-0921"),
  },
  {
    ref: "JOB-PAL3D-0927",
    title: "Above threshold, paid over Stellar",
    line: "Ana's $750 needs a person. Approve, then pay with Stellar, the rail she asked for. Here the Stellar leg is simulated; with the anchor leg built she would see a PHP bank deposit in about 15 minutes.",
    pick: (rows) => rows.find((r) => r.sourceRef === "JOB-PAL3D-0927"),
  },
];

export default function DemoPage() {
  const rows = findObligationsBySourceRef(STORY.map((s) => s.ref));
  const o = getOverview();
  const base = o.business?.baseCurrency ?? "USD";
  const found = STORY.map((s) => ({ ...s, row: s.pick(rows) }));
  const missing = found.filter((f) => !f.row);

  return (
    <>
      <PageHeader title="Presenter" lede="The four obligations the three-minute video walks through, in order. Open each one from here; reset between takes." actions={<ResetDemoButton />} />

      <div className="mb-6 grid grid-cols-2 gap-4 border-y hairline py-3 sm:grid-cols-4">
        <Stat label="Needs you" value={String(o.counts.needsAction)} />
        <Stat label="Errors prevented" value={formatMoneySymbol(o.money.preventedMinor, base)} />
        <Stat label="Paid, 30 days" value={formatMoneySymbol(o.money.paid30dMinor, base)} />
        <Stat label="Modes" value={`${o.system.railModes.paypal} / ${o.system.railModes.stellar}`} small />
      </div>

      {missing.length === STORY.length ? (
        <EmptyState title="The story is not loaded" body="Reset the demo to seed the four obligations and a month of history." action={<ResetDemoButton />} />
      ) : (
        <ol className="space-y-4">
          {found.map((f, i) => (
            <li key={f.ref} className="panel">
              <div className="grid gap-4 px-5 py-4 sm:grid-cols-[32px_minmax(0,1fr)_auto]">
                <span className="wide num text-xl text-ink-soft">{i + 1}</span>
                <div className="min-w-0">
                  <h2 className="font-medium">{f.title}</h2>
                  <p className="mt-1 text-ink-soft">{f.line}</p>
                  {f.row ? (
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <CheckLine state={f.row.state} variant="compact" hasAccounting />
                      <StatePill state={f.row.state} />
                      <span className="num text-ink-soft">{f.row.vendorName}, {f.ref}</span>
                      <Money minor={f.row.amountMinor} currency={f.row.currency} />
                      {f.row.selectedRail ? <RailTag rail={f.row.selectedRail} /> : null}
                    </div>
                  ) : (
                    <p className="mt-3 text-attention">Not in the database. Reset the demo.</p>
                  )}
                </div>
                <div className="flex items-start sm:justify-end">
                  {f.row ? (
                    <Link href={`/obligations/${f.row.id}`} className="btn btn-primary">
                      Open obligation
                    </Link>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="font-medium">Suggested order</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-soft">
            <li>Overview: the shared check line, two breaks, errors prevented.</li>
            <li>Phuong: the mismatch, the rule that caught it, correct to $800.</li>
            <li>Maria duplicate: the reference was paid 17 days ago; cancel it.</li>
            <li>Maria JOB-HG4D-0921: pay with PayPal, marker travels to reconciled.</li>
            <li>Ana: approve, compare rails, pay, open the settlement.</li>
            <li>
              New request: type &quot;Invoice attached from Rosa, please pay.&quot; and upload <a href="/demo-documents/invoice-rosa-0942.pdf" className="link" download>Rosa&apos;s invoice (USD 205)</a>. The amount and reference are read from the document, which names Rosa in full, so it comes out clean and pre-approved. Leave the vendor out of the message and it waits for a person to confirm the payee instead: a document can mention several people.
            </li>
            <li>Settings: turn on Autopilot. Back on the overview it is scheduled with a countdown. Cancel it, or let the window run out and watch the agent send it.</li>
            <li>Try to fool it: upload <a href="/demo-documents/invoice-tam-0834b.pdf" className="link" download>Tam&apos;s re-issued invoice</a> (blocked as a duplicate) or <a href="/demo-documents/invoice-bayan-0944.pdf" className="link" download>Bayan&apos;s USD 640 charter</a> (held for a person, even on Autopilot).</li>
            <li>Daily close: what needs a look, what the agent sent, what people sent. Sign off.</li>
            <li>Ledger and accounting: the same records, ready for Xero.</li>
          </ol>
          <p className="mt-3 text-sm text-ink-soft">
            This demo runs on simulated rails and the rule-based reader, so it works with no keys. Ana settles on simulated Stellar here; in the live PayPal sandbox run her payout came back UNCLAIMED instead. The hosted copy restores the opening requests after 30 minutes without use, or press Reset demo.
          </p>
        </div>
        <div className="panel p-4">
          <h2 className="font-medium">Links</h2>
          <ul className="mt-2 space-y-1">
            {[
              ["/", "Overview"],
              ["/obligations?filter=needs_action", "Inbox, needs action"],
              ["/exceptions", "Exceptions"],
              ["/ledger", "Ledger"],
              ["/accounting", "Accounting"],
              ["/vendors/ven_ana", "Ana Reyes, vendor page"],
              ["/settings", "Settings and modes"],
            ].map(([href, label]) => (
              <li key={href}>
                <Link href={href} className="link">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  return (
    <div>
      <p className="dense text-ink-soft">{label}</p>
      <p className={`wide num ${small ? "text-lg" : "text-xl"}`}>{value}</p>
    </div>
  );
}
