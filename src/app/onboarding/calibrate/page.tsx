import Link from "next/link";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { getImport } from "@/lib/onboarding/imports";
import { importCalls, onboardingDashboard } from "@/lib/onboarding/dashboard";
import { pluralise } from "@/lib/format";
import { EmptyState, PageHeader } from "@/components/ui";
import { Stepper } from "@/components/onboarding/Stepper";
import { CallsBoard } from "@/components/onboarding/CallsBoard";
import { SuggestionsPanel } from "@/components/onboarding/SuggestionsPanel";
import { summarise } from "@/components/onboarding/calibrate-model";
import { shortDate } from "@/components/onboarding/import-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Check our calls" };

export default async function CheckOurCallsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  const biz = getBusiness();
  const header = <PageHeader title="Check our calls against your history" lede="Checkrail ran your past payments through its rules as if each were asked for that day. Tell it which calls were right; your marks suggest changes, and nothing changes until you apply one." />;
  if (!biz) {
    return (
      <>
        <Stepper current={2} />
        {header}
        <EmptyState title="No business configured" body="Reset the demo from the overview to load Ridgeline Expeditions." />
      </>
    );
  }
  const db = getDb();
  const params = await searchParams;
  const asked = typeof params.import === "string" ? params.import : null;
  const one = asked ? getImport(db, biz.id, asked) : null;
  const data = onboardingDashboard(db, biz.id);
  const imp = one?.status === "checked" ? one : null;
  const calls = imp ? importCalls(db, biz.id, imp.id) : data.calls;
  const summary = imp
    ? summarise([{ status: imp.status, currency: imp.currency, payments: imp.payments, would_have_blocked_minor: imp.wouldHaveBlockedMinor, blocked_count: imp.blockedCount, held_count: imp.heldCount, clear_count: imp.clearCount, period_from: imp.periodFrom, period_to: imp.periodTo }])
    : summarise(data.imports);
  const can = { approve: !viewer || viewer.can("approve"), verify_vendor: !viewer || viewer.can("verify_vendor"), settings: !viewer || viewer.can("settings") };

  return (
    <>
      <Stepper current={2} />
      {header}

      {asked && !imp ? <p className="mb-4 rounded-lg bg-attention-soft px-4 py-2.5 text-attention">That re-check was not found or did not finish, so every re-check is shown.</p> : null}

      {summary ? (
        <>
          <p className="mb-4 text-ink-soft">
            {imp ? (
              <>
                From <span className="mono text-[13px] text-ink">{imp.fileName}</span>, {shortDate(imp.periodFrom)} to {shortDate(imp.periodTo)}.{" "}
                <Link href="/onboarding/calibrate" className="link">
                  Show every re-check
                </Link>
              </>
            ) : (
              <>
                {pluralise(summary.imports, "re-check")}, {shortDate(summary.periodFrom)} to {shortDate(summary.periodTo)}. Open one from Bring in your data to see only its calls.
              </>
            )}
          </p>
          <CallsBoard rows={calls} summary={summary} canMark={can.approve} />
          <div className="mt-10">
            <SuggestionsPanel rows={data.suggestions} can={{ verify_vendor: can.verify_vendor, settings: can.settings }} />
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t pt-6 hairline">
            <p className="max-w-xl text-ink-soft">Next, watch how Checkrail does on new payments, week by week, and when it is ready to do more on its own.</p>
            <Link href="/onboarding/dashboard" className="btn btn-primary">
              Your first weeks
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" />
              </svg>
            </Link>
          </div>
        </>
      ) : (
        <EmptyState
          title="Nothing re-checked yet"
          body="Bring in a bank export first. Checkrail re-checks its last 90 days and lists every call here for you to mark."
          action={
            <Link href="/onboarding" className="btn btn-primary">
              Bring in your data
            </Link>
          }
        />
      )}
    </>
  );
}
