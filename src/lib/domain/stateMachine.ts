import { eq, desc } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, auditEntries } from "../db/schema";
import { TRANSITIONS, type ObligationState } from "./types";
import { newId, now } from "./ids";

export class IllegalTransition extends Error {
  constructor(public from: ObligationState, public to: ObligationState) {
    super(`Illegal transition ${from} -> ${to}`);
  }
}

export interface AuditDetail {
  [key: string]: unknown;
}

/** Append an audit entry. Entries are never updated or deleted. */
export function audit(
  db: Db,
  entry: { obligationId: string | null; actor: string; action: string; fromState?: ObligationState | null; toState?: ObligationState | null; detail?: AuditDetail }
): void {
  const last = db.select({ seq: auditEntries.seq }).from(auditEntries).orderBy(desc(auditEntries.seq)).limit(1).get();
  db.insert(auditEntries)
    .values({
      id: newId("aud"),
      obligationId: entry.obligationId,
      seq: (last?.seq ?? 0) + 1,
      actor: entry.actor,
      action: entry.action,
      fromState: entry.fromState ?? null,
      toState: entry.toState ?? null,
      detailJson: entry.detail ? JSON.stringify(entry.detail) : null,
      createdAt: now(),
    })
    .run();
}

/**
 * Move an obligation to a new state, enforcing the transition table and
 * recording the move in the audit log in the same transaction.
 */
export function transition(
  db: Db,
  obligationId: string,
  to: ObligationState,
  actor: string,
  action: string,
  detail?: AuditDetail
): { from: ObligationState; to: ObligationState } {
  return db.transaction((tx) => {
    const row = tx.select({ state: obligations.state }).from(obligations).where(eq(obligations.id, obligationId)).get();
    if (!row) throw new Error(`Obligation ${obligationId} not found`);
    const from = row.state as ObligationState;
    if (from !== to && !TRANSITIONS[from].includes(to)) throw new IllegalTransition(from, to);
    tx.update(obligations).set({ state: to, updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
    audit(tx as unknown as Db, { obligationId, actor, action, fromState: from, toState: to, detail });
    return { from, to };
  });
}
