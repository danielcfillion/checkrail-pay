import { EmptyState } from "@/components/ui";
import { FirstWeeksDashboard } from "@/components/onboarding/studio/FirstWeeksDashboard";
import { isLiveAi } from "@/lib/config";
import { getDb } from "@/lib/db";
import { onboardingDashboard, type DashboardData } from "@/lib/onboarding/dashboard";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your first weeks" };

/**
 * Setup, step 3: "Your first weeks". Reads only. The data comes from onboardingDashboard() (the same rows as
 * GET /api/onboarding/dashboard); the dashboard itself is AG Studio, in the browser.
 *
 *   AG_STUDIO      the AG Studio licence key, read here on the server and handed to Studio. Without it Studio runs
 *                  with a trial watermark.
 *   isLiveAi()     shows the assistant ("Ask about your setup"), which talks to Claude through /api/studio-ai. In
 *                  mock AI mode it is hidden; the page never probes the route.
 */
export default async function FirstWeeksPage() {
  const biz = getBusiness();
  const viewer = await getViewer();
  if (!biz || !viewer) return <EmptyState title="No business configured" body="Reset the demo from the overview." />;

  let data: DashboardData;
  try {
    data = onboardingDashboard(getDb(), biz.id);
  } catch {
    return <EmptyState title="Nothing to show yet" body="Bring in a bank export first; this dashboard fills in once Checkrail has re-checked it." />;
  }

  return (
    <>
      {/* TODO(stepper): replace this line with the shared onboarding stepper (src/components/onboarding/Stepper.tsx), step 3 of 3. */}
      <p className="dense mb-2 uppercase tracking-[0.08em] text-ink-soft">Setup · Step 3 of 3</p>
      <FirstWeeksDashboard data={data} licenseKey={process.env.AG_STUDIO || undefined} assistant={isLiveAi() ? { business: biz.name } : null} />
    </>
  );
}
