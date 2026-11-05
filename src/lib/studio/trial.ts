/**
 * The AG Studio trial notice. AG_STUDIO_TRIAL_ENDS is the last day the trial licence works (YYYY-MM-DD). From the
 * day after it, the dashboard shows a notice that names the date and who to contact. Unset or malformed: no notice.
 */
export const TRIAL_CONTACT = "danielcfillion@gmail.com";

export interface TrialNotice {
  /** The end date as people read it, such as "14 Dec 2026". */
  label: string;
  contact: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The notice to show on `today` (YYYY-MM-DD, the server's date), or null while the trial runs or when no end date is set. */
export function trialNotice(endsOn: string | undefined, today: string): TrialNotice | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((endsOn ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (today <= `${m[1]}-${m[2]}-${m[3]}`) return null;
  return { label: `${day} ${MONTHS[month - 1]} ${m[1]}`, contact: TRIAL_CONTACT };
}
