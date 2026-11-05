import { EmptyState } from "@/components/ui";
import { Stepper } from "@/components/onboarding/Stepper";
import { FirstWeeksDashboard } from "@/components/onboarding/studio/FirstWeeksDashboard";
import { isStudioAssistantOn } from "@/lib/config";
import { getDb } from "@/lib/db";
import { onboardingDashboard, type DashboardData } from "@/lib/onboarding/dashboard";
import { getBusiness } from "@/lib/queries";
import { trialNotice } from "@/lib/studio/trial";
import { TrialNotice } from "@/components/onboarding/studio/TrialNotice";
import { localDateString } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your first weeks" };

/**
 * Setup, step 3: "Your first weeks". Reads only. The data comes from onboardingDashboard() (the same rows as
 * GET /api/onboarding/dashboard); the dashboard itself is AG Studio, in the browser.
 *
 *   AG_STUDIO      the AG Studio licence key, read here on the server and handed to Studio. Without it Studio runs
 *                  with a trial watermark.
 *   AG_STUDIO_TRIAL_ENDS  last day of the trial licence (YYYY-MM-DD); after it a pop-up names the date and who to contact.
 *   isStudioAssistantOn()  shows the assistant ("Ask about your setup"), which talks to Claude through /api/studio-ai.
 *                  On with live AI, or with STUDIO_ASSISTANT=1 and a key while AI_MODE stays mock. Otherwise it is
 *                  hidden; the page never probes the route.
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

  const notice = trialNotice(process.env.AG_STUDIO_TRIAL_ENDS, localDateString());
  return (
    <>
      <Stepper current={3} />
      {notice ? <TrialNotice notice={notice} /> : null}
      <FirstWeeksDashboard data={data} licenseKey={process.env.AG_STUDIO || undefined} assistant={isStudioAssistantOn() ? { business: biz.name } : null} />
    </>
  );
}
