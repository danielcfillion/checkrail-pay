import { pluralise } from "@/lib/format";

/**
 * The overview's headline about what needs a person. Two different numbers, each named for what it is:
 *  - "waiting on you": what this viewer's role lets them do next (waitingIdsFor, the same number as the sidebar, the
 *    Inbox tab and Daily close);
 *  - "need action": every request in a state that needs somebody (the Needs action list), whoever that is.
 * `mine` is null when nobody is signed in, and then only the second is said.
 */
export type WaitingLine = { lead: string; leadHref: string | null; rest: string | null; restHref: string | null };

const NEEDS_ACTION = "/obligations?filter=needs_action";
const MINE = "/obligations?filter=mine";

export function waitingLine({ mine, needsAction }: { mine: number | null; needsAction: number }): WaitingLine {
  if (mine === null) {
    return needsAction === 0
      ? { lead: "Nothing needs action right now.", leadHref: null, rest: null, restHref: null }
      : { lead: `${pluralise(needsAction, "request")} need${needsAction === 1 ? "s" : ""} action.`, leadHref: NEEDS_ACTION, rest: null, restHref: null };
  }
  const all = needsAction > mine ? `${needsAction} need action in all.` : null;
  return mine === 0
    ? { lead: "Nothing waits on you right now.", leadHref: null, rest: needsAction > 0 ? `${needsAction} need action in all.` : null, restHref: needsAction > 0 ? NEEDS_ACTION : null }
    : { lead: `${pluralise(mine, "request")} wait${mine === 1 ? "s" : ""} on you.`, leadHref: MINE, rest: all, restHref: all ? NEEDS_ACTION : null };
}
