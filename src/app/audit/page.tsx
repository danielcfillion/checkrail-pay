import Link from "next/link";
import { listAudit } from "@/lib/queries";
import { formatDateTime, humaniseAction, humaniseActor, stateLabel } from "@/lib/format";
import { EmptyState, PageHeader, RelativeTime } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log" };

const PAGE = 100;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const sp = await searchParams;
  const before = Number(sp.before);
  const rows = listAudit(PAGE + 1, undefined, Number.isFinite(before) && before > 0 ? before : undefined);
  const more = rows.length > PAGE;
  if (more) rows.pop();
  const oldest = rows.at(-1)?.seq;
  return (
    <>
      <PageHeader title="Audit log" lede="Every step every actor took, newest first. The agent, the policy engine, the router, the rails and people all write here. Nothing is edited after the fact." />
      {rows.length === 0 ? (
        <EmptyState title="No entries yet" body="The log fills as soon as the first payment request is created." />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col" className="r">
                  Seq
                </th>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col" className="hidden md:table-cell">
                  Request
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  Transition
                </th>
                <th scope="col" className="hidden xl:table-cell">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="r num text-ink-soft">{a.seq}</td>
                  <td className="whitespace-nowrap text-ink-soft">
                    <RelativeTime iso={a.createdAt} />
                  </td>
                  <td>{humaniseActor(a.actor)}</td>
                  <td className="font-medium">{humaniseAction(a.action)}</td>
                  <td className="hidden md:table-cell">
                    {a.obligationId ? (
                      <Link href={`/obligations/${a.obligationId}`} className="hover:underline">
                        {a.vendorName ?? "Unknown vendor"}
                        {a.sourceRef ? <span className="num text-ink-soft">, {a.sourceRef}</span> : null}
                      </Link>
                    ) : (
                      <span className="text-ink-soft">Business setting</span>
                    )}
                  </td>
                  <td className="hidden text-ink-soft lg:table-cell">{a.toState ? (a.fromState ? `${stateLabel(a.fromState)} to ${stateLabel(a.toState)}` : stateLabel(a.toState)) : ""}</td>
                  <td className="hidden max-w-[360px] xl:table-cell">
                    {a.detail ? (
                      <details>
                        <summary className="dense text-ink-soft hover:text-ink">{summarise(a.detail)}</summary>
                        <pre className="num mt-1 max-h-48 overflow-auto rounded bg-paper p-2 text-2xs leading-4 text-ink-soft" style={{ fontFamily: "inherit", fontStretch: "92%" }}>
                          {JSON.stringify(a.detail, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      <span className="text-ink-soft" title={formatDateTime(a.createdAt)}>
                        none
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(more || Number.isFinite(before)) && rows.length > 0 ? (
        <p className="mt-4 flex gap-4 text-sm">
          {Number.isFinite(before) && before > 0 ? (
            <Link href="/audit" className="link">
              Newest
            </Link>
          ) : null}
          {more ? (
            <Link href={`/audit?before=${oldest}`} className="link">
              Older entries
            </Link>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

function summarise(d: Record<string, unknown>): string {
  const keys = Object.keys(d);
  if (!keys.length) return "empty";
  const first = keys.slice(0, 3).map((k) => {
    const v = d[k];
    const s = typeof v === "string" ? v : Array.isArray(v) ? `${v.length} items` : typeof v === "object" && v ? "object" : String(v);
    return `${k}: ${s.length > 40 ? s.slice(0, 38) + "…" : s}`;
  });
  return first.join(", ") + (keys.length > 3 ? ` and ${keys.length - 3} more` : "");
}
