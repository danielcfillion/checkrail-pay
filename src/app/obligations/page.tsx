import { runAs } from "@/lib/engine/requestContext";
import Link from "next/link";
import { listObligations, waitingIdsFor } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import type { ObligationState } from "@/lib/domain/types";
import { ObligationTable } from "@/components/ObligationList";
import { EmptyState, PageHeader } from "@/components/ui";
import { pluralise } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox" };

const FILTERS: Array<{ key: string; label: string; states?: ObligationState[] }> = [
  { key: "all", label: "All" },
  { key: "needs_action", label: "Needs action", states: ["needs_evidence", "awaiting_approval", "approved", "blocked", "failed"] },
  { key: "in_flight", label: "In flight", states: ["execution_pending", "sent"] },
  { key: "settled", label: "Settled", states: ["settled"] },
  { key: "blocked", label: "Blocked", states: ["blocked", "failed"] },
];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter = "all" } = await searchParams;
  const viewer = await getViewer();
  const mineIds = viewer ? new Set(runAs(viewer.login, () => waitingIdsFor(viewer.actor))) : null;
  const filters = mineIds ? [{ key: "mine", label: "Waiting for you" }, ...FILTERS] : FILTERS;
  const active = filters.find((f) => f.key === filter) ?? FILTERS[0];
  const rows = active.key === "mine" && mineIds ? listObligations({ limit: 1000 }).filter((r) => mineIds.has(r.id)) : listObligations({ states: active.states, limit: 500 });
  const counts: Record<string, number> = Object.fromEntries(FILTERS.map((f) => [f.key, listObligations({ states: f.states, limit: 1000 }).length]));
  if (mineIds) counts.mine = mineIds.size;

  return (
    <>
      <PageHeader
        title="Inbox"
        lede="Every obligation the business has been asked to pay, from first mention to the books."
        actions={
          !viewer || viewer.can("ingest") ? (
            <Link href="/obligations/new" className="btn btn-primary">
              New obligation
            </Link>
          ) : undefined
        }
      />
      <nav aria-label="Filter" className="mb-4 flex flex-wrap gap-1 border-b hairline">
        {filters.map((f) => {
          const on = f.key === active.key;
          return (
            <Link
              key={f.key}
              href={f.key === "all" ? "/obligations" : `/obligations?filter=${f.key}`}
              aria-current={on ? "page" : undefined}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 ${on ? "border-ink text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}
            >
              {f.label}
              <span className="num text-xs text-ink-soft">{counts[f.key]}</span>
            </Link>
          );
        })}
      </nav>
      {rows.length ? (
        <ObligationTable rows={rows} />
      ) : (
        <EmptyState
          title={active.key === "all" ? "No obligations yet" : active.key === "mine" ? "Nothing waiting for you" : `Nothing ${active.label.toLowerCase()}`}
          body={active.key === "all" ? "Paste an invoice, a job sheet or a chat message and the agent will read it." : "Switch filter, or add a new obligation."}
          action={
            <Link href={active.key === "mine" ? "/obligations" : "/obligations/new"} className="btn">
              {active.key === "mine" ? "See everything" : "New obligation"}
            </Link>
          }
        />
      )}
      <p className="mt-3 text-xs text-ink-soft">{pluralise(rows.length, "obligation")} shown.</p>
    </>
  );
}
