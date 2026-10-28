export const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/**
 * The router's reason without its list of unavailable rails: each rail's own card, or the line under the
 * cards, already says why it cannot pay, so the note says it once.
 */
export function routerNote(reason: string): string {
  return reason.replace(/\s*\((?:[A-Z][\w ]*: [^()]*(?:\([^()]*\)[^()]*)*)\)\s*\.?$/, ".").replace(/\.\.$/, ".");
}
