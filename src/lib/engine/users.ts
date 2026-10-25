import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { auditEntries, users } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { now } from "../domain/ids";
import { DEMO_PERSONAS, ROLE_LABEL, can, isRole, type Permission, type Role } from "../auth/roles";

/**
 * The person acting, as the server sees them. Built from the headers the middleware set (login or persona) and the
 * users table (display name, approval limit, delegation). Server actions get one of these and check it with
 * `requirePermission`; the engine records `id` as the audit actor.
 */
export interface Actor {
  /** Audit actor, "user:<username>". */
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** Most this person may approve, base currency minor units. null = no limit. 0 = may not approve. */
  approvalLimitMinor: number | null;
  /** People whose approvals this person is covering right now (delegation). */
  coveringFor: string[];
  /** The real login when acting as a demo persona. */
  viaLogin?: string;
}

const DEFAULT_LIMIT: Record<Role, number | null> = { admin: null, approver: 100_000, clerk: 0, accountant: 0 };

/** Look up (and on first sight, record) the acting user. The role from the login is authoritative. */
export function resolveActor(db: Db, businessId: string, username: string, role: Role, viaLogin?: string): Actor {
  let row = db.select().from(users).where(and(eq(users.id, username), eq(users.businessId, businessId))).get();
  if (!row) {
    const persona = DEMO_PERSONAS.find((p) => p.username === username);
    db.insert(users)
      .values({ id: username, businessId, displayName: persona?.name ?? username, role, approvalLimitMinor: persona ? persona.limitMinor : DEFAULT_LIMIT[role], active: true, createdAt: now() })
      .onConflictDoNothing()
      .run();
    row = db.select().from(users).where(eq(users.id, username)).get()!;
  } else if (row.role !== role) {
    // Configuration changed this person's role; follow it, and say so.
    db.update(users).set({ role }).where(eq(users.id, username)).run();
    audit(db, { obligationId: null, actor: "system", action: "user.role_synced", detail: { user: username, from: row.role, to: role } });
    row = { ...row, role };
  }
  if (!row.active) throw new Error("This login has been deactivated");
  // Delegation: approvers away until a date hand their approvals (and their limit) to someone else.
  const ts = now();
  const covering = db
    .select()
    .from(users)
    .where(and(eq(users.businessId, businessId), eq(users.delegateTo, username)))
    .all()
    .filter((u) => u.active && u.delegateUntil && u.delegateUntil > ts && can(u.role as Role, "approve"));
  let limit = role === "admin" ? null : (row.approvalLimitMinor ?? DEFAULT_LIMIT[role]);
  for (const c of covering) {
    const theirs = c.role === "admin" ? null : c.approvalLimitMinor ?? DEFAULT_LIMIT[c.role as Role];
    if (theirs === null) limit = null;
    else if (limit !== null && theirs > limit) limit = theirs;
  }
  return { id: `user:${username}`, username, displayName: row.displayName, role, approvalLimitMinor: limit, coveringFor: covering.map((c) => c.id), viaLogin };
}

/** Effective permission, including approvals delegated to this person. */
export function actorCan(a: Actor, p: Permission): boolean {
  if (can(a.role, p)) return true;
  return a.coveringFor.length > 0 && (p === "approve" || p === "verify_vendor" || p === "sign_off");
}

/** "Lan (AP clerk)" for a demo persona whose name already says it, "lan (AP clerk)" for a plain login. */
export function whoIs(a: Pick<Actor, "displayName" | "role">): string {
  return a.displayName.includes("(") ? a.displayName : `${a.displayName} (${ROLE_LABEL[a.role]})`;
}

export function requirePermission(a: Actor, p: Permission, what: string): void {
  if (!actorCan(a, p)) throw new Error(`${whoIs(a)} cannot ${what}. Ask someone with the right role.`);
}

/** How many active people could approve a payment of this size. Separation of duties needs at least two. */
export function approversFor(db: Db, businessId: string, amountMinor: number): string[] {
  return db
    .select()
    .from(users)
    .where(eq(users.businessId, businessId))
    .all()
    .filter((u) => u.active && isRole(u.role) && can(u.role, "approve") && (u.role === "admin" || u.approvalLimitMinor === null || (u.approvalLimitMinor ?? 0) >= amountMinor))
    .map((u) => u.id);
}

export interface TeamChange {
  username: string;
  displayName?: string;
  approvalLimitMinor?: number | null;
  delegateTo?: string | null;
  delegateUntil?: string | null;
  active?: boolean;
}

/** Admin-only edits to a person's limit, delegation and status. Roles come from the login configuration. */
export function updateTeamMember(db: Db, businessId: string, by: Actor, change: TeamChange): void {
  requirePermission(by, "manage_users", "change the team");
  const row = db.select().from(users).where(and(eq(users.id, change.username), eq(users.businessId, businessId))).get();
  if (!row) throw new Error("No such person");
  const patch: Partial<typeof users.$inferInsert> = {};
  if (change.displayName !== undefined) {
    const n = change.displayName.trim();
    if (!n || n.length > 80) throw new Error("Name must be 1 to 80 characters");
    patch.displayName = n;
  }
  if (change.approvalLimitMinor !== undefined) {
    if (change.approvalLimitMinor !== null && !(Number.isSafeInteger(change.approvalLimitMinor) && change.approvalLimitMinor >= 0 && change.approvalLimitMinor <= 100_000_000)) throw new Error("Approval limit must be a whole amount between 0 and 1,000,000");
    patch.approvalLimitMinor = change.approvalLimitMinor;
  }
  if (change.delegateTo !== undefined) {
    if (change.delegateTo === change.username) throw new Error("A person cannot delegate to themselves");
    if (change.delegateTo && !db.select().from(users).where(and(eq(users.id, change.delegateTo), eq(users.businessId, businessId))).get()) throw new Error("No such delegate");
    patch.delegateTo = change.delegateTo;
    if (change.delegateTo && !change.delegateUntil) throw new Error("A delegation needs an end date");
  }
  if (change.delegateUntil !== undefined) {
    if (change.delegateUntil && !(new Date(change.delegateUntil).getTime() > Date.now())) throw new Error("The delegation end date must be in the future");
    patch.delegateUntil = change.delegateUntil;
  }
  if (change.active !== undefined) {
    if (!change.active && change.username === by.username) throw new Error("You cannot deactivate yourself");
    patch.active = change.active;
  }
  db.update(users).set(patch).where(eq(users.id, change.username)).run();
  audit(db, { obligationId: null, actor: by.id, action: "team.changed", detail: { user: change.username, patch } });
}

export function listTeam(db: Db, businessId: string) {
  return db.select().from(users).where(eq(users.businessId, businessId)).all();
}

/** Seed the demo team so the personas exist before anyone signs in. */
export function seedDemoTeam(db: Db, businessId: string): void {
  for (const p of DEMO_PERSONAS) {
    db.insert(users).values({ id: p.username, businessId, displayName: p.name, role: p.role, approvalLimitMinor: p.limitMinor, active: true, createdAt: now() }).onConflictDoNothing().run();
  }
}

/** Everyone who took part in preparing an obligation: who created it and who changed its amount, payee or reference. */
export function preparersOf(db: Db, obligationId: string): string[] {
  return [
    ...new Set(
      db
        .select({ actor: auditEntries.actor, action: auditEntries.action })
        .from(auditEntries)
        .where(eq(auditEntries.obligationId, obligationId))
        .all()
        .filter((a) => a.action === "obligation.created" || a.action === "obligation.amended")
        .map((a) => a.actor)
        .filter((a) => a.startsWith("user:")),
    ),
  ];
}
