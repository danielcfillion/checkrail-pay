/**
 * The autopilot cancel window in words. Settings allows whole minutes (one at least); the judge tour sets a window of
 * seconds, which must read as what it is, never "0 minutes".
 */
export function cancelWindowText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} (shortened for the tour)`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** What the minutes field starts with: the window in minutes, but never below the one minute Settings allows. */
export function cancelWindowMinutesField(seconds: number): string {
  return String(Math.max(1, Math.round(seconds / 60)));
}
