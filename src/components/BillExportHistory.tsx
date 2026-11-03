import type { BillExportSummary } from "@/lib/accounting/xeroBills";
import { formatShortDateTime, humaniseActor, pluralise } from "@/lib/format";

/**
 * Every Xero bills file exported so far, newest first, each downloadable again. The file is identical to the first
 * download, which is exactly why the page says it must not be imported a second time.
 */
export function BillExportHistory({ exports }: { exports: BillExportSummary[] }) {
  if (!exports.length) return null;
  const [last, ...earlier] = exports;
  return (
    <section className="panel mb-5 px-4 py-3" aria-labelledby="bill-exports-heading">
      <h2 id="bill-exports-heading" className="font-medium">
        Bills files exported for Xero
      </h2>
      <p className="mt-1 text-sm">
        Last: <span className="num">{pluralise(last.billCount, "bill")}</span> exported <span className="num">{formatShortDateTime(last.createdAt)}</span> by {humaniseActor(last.actor)}.{" "}
        <a className="link" href={`/api/accounting/bill-exports/${encodeURIComponent(last.id)}`} download>
          Download again
        </a>
      </p>
      <p className="mt-1 max-w-3xl text-sm text-attention">Download again gives the identical file. Import each file into Xero once: importing it again creates every bill in it a second time.</p>
      {earlier.length ? (
        <ul className="mt-2 divide-y hairline text-sm">
          {earlier.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
              <span className="num">{pluralise(e.billCount, "bill")}</span>
              <span className="num text-ink-soft">exported {formatShortDateTime(e.createdAt)}</span>
              <span className="text-ink-soft">by {humaniseActor(e.actor)}</span>
              <a className="link ml-auto" href={`/api/accounting/bill-exports/${encodeURIComponent(e.id)}`} download>
                Download again
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
