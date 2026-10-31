import { EmptyState } from "@/components/ui";
import { Stepper } from "@/components/onboarding/Stepper";
import { FirstWeeksDashboard } from "@/components/onboarding/studio/FirstWeeksDashboard";
import { isLiveAi } from "@/lib/config";
import { getDb } from "@/lib/db";
import { onboardingDashboard, type DashboardData } from "@/lib/onboarding/dashboard";
import { getBusiness } from "@/lib/queries";

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
  if (!biz) return <EmptyState title="No business configured" body="Reset the demo from the overview." />;

  let data: DashboardData;
  try {
    data = onboardingDashboard(getDb(), biz.id);
  } catch {
    return <EmptyState title="Nothing to show yet" body="Bring in a bank export first; this dashboard fills in once Checkrail has re-checked it." />;
  }

  return (
    <>
      <Stepper current={3} />
      <FirstWeeksDashboard data={data} licenseKey={process.env.AG_STUDIO || undefined} assistant={isLiveAi() ? { business: biz.name } : null} />
    </>
  );
}
