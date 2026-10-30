/**
 * Which Inbox tab opens when the link names none: "Waiting for you" when something is, otherwise "All". A link that
 * names a tab, including ?filter=all, always gets that tab. `waiting` is null when nobody is signed in.
 */
export function defaultInboxFilter(asked: string | undefined, waiting: number | null): string {
  if (asked) return asked;
  return waiting !== null && waiting > 0 ? "mine" : "all";
}
