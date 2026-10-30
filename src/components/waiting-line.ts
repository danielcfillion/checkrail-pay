import { pluralise } from "@/lib/format";

/**
 * The overview's headline about what needs a person. Two different numbers, each named for what it is:
 *  - "wait on you": what this viewer's role lets them do next (waitingIdsFor, the same number as the sidebar, the
 *    Inbox tab and Daily close);
 *  - "need someone": every request in a state that needs somebody (the Needs someone list and Inbox tab), whoever
 *    that is: an approver, a clerk, the vendor.
 * `mine` is null when nobody is signed in, and then only the second is said.
 */
export type WaitingLine = { lead: string; leadHref: string | null; rest: string | null; restHref: string | null };

const NEEDS_SOMEONE = "/obligations?filter=needs_action";
const MINE = "/obligations?filter=mine";

export function waitingLine({ mine, needsSomeone }: { mine: number | null; needsSomeone: number }): WaitingLine {
  if (mine === null) {
    return needsSomeone === 0
      ? { lead: "Nothing needs anyone right now.", leadHref: null, rest: null, restHref: null }
      : { lead: `${pluralise(needsSomeone, "request")} need${needsSomeone === 1 ? "s" : ""} someone.`, leadHref: NEEDS_SOMEONE, rest: null, restHref: null };
  }
  const all = needsSomeone > mine ? `${needsSomeone} in all need someone.` : null;
  return mine === 0
    ? { lead: "Nothing waits on you right now.", leadHref: null, rest: needsSomeone > 0 ? `${needsSomeone} in all need someone.` : null, restHref: needsSomeone > 0 ? NEEDS_SOMEONE : null }
    : { lead: `${pluralise(mine, "request")} wait${mine === 1 ? "s" : ""} on you.`, leadHref: MINE, rest: all, restHref: all ? NEEDS_SOMEONE : null };
}
