/** "No licensed VND off-ramp" to "no licensed ...", but a name stays a name ("Maria Santos has no ..."). */
export const lowerFirst = (t: string) => (/^[A-Z][a-z]+\s+[a-z]/.test(t) || /^[A-Z][a-z]+$/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/**
 * The router's reason without its list of unavailable rails: each rail's own card, or the line under the
 * cards, already says why it cannot pay, so the note says it once.
 */
export function routerNote(reason: string): string {
  return reason.replace(/\s*\((?:[A-Z][\w ]*: [^()]*(?:\([^()]*\)[^()]*)*)\)\s*\.?$/, ".").replace(/\.\.$/, ".");
}

/**
 * The line under the rail cards. The router's tie-break arithmetic ("PHP 59.54 per USD spent") is already on the
 * cards, so a tie says only why the rail won; a request that is ready to pay leads with that.
 * "Ready to pay over PayPal. It costs the same as Stellar here and runs more of the way end to end."
 */
export function routeLine(reason: string | null, rail: string | null, ready: boolean, label: (r: string) => string): string | null {
  const why = reason ? routerNote(reason) : null;
  const tie = why?.match(/^Effectively equal cost across (.+?) \(.*?\)\. (\w+) wins the tie because more of its path runs end to end(?:; (.+?) (?:is|are) faster)?\.$/);
  const tieLine = tie ? `It costs the same as ${tie[1].split(" and ").filter((r) => r !== tie[2]).join(" and ")} here and runs more of the way end to end${tie[3] ? `; ${tie[3]} is faster` : ""}.` : null;
  if (ready && rail) return [`Ready to pay over ${label(rail)}.`, tieLine ?? (why && !/^No supported route/.test(why) ? why : null)].filter(Boolean).join(" ");
  return tieLine ? `${tie![2]} is chosen. ${tieLine}` : why;
}
