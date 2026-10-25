/**
 * Roles and what each may do. Pure, so it runs in the Edge middleware, server actions and tests alike.
 *
 *  - admin:      everything, including autonomy, caps, users and the demo reset.
 *  - approver:   approves and rejects payments up to their limit, verifies vendor payout details, signs off the
 *                Daily close, releases payment runs.
 *  - clerk:      prepares: takes in requests and documents, corrects them, manages vendors and invites, builds
 *                payment runs and sends payments that are already approved. Cannot approve or verify.
 *  - accountant: reads everything, exports, imports statements, locks periods. Moves no money.
 *
 * Pausing autopilot and cancelling a scheduled release are open to every role except accountant: stopping money is
 * always allowed; starting it is not.
 */
export type Role = "admin" | "approver" | "clerk" | "accountant";
export const ROLES: readonly Role[] = ["admin", "approver", "clerk", "accountant"];

export type Permission =
  | "ingest"
  | "amend"
  | "pay"
  | "approve"
  | "verify_vendor"
  | "edit_vendor"
  | "invite_vendor"
  | "sign_off"
  | "export"
  | "reconcile"
  | "lock_period"
  | "stop"
  | "resolve_stuck"
  | "build_run"
  | "release_run"
  | "settings"
  | "manage_users"
  | "reset_demo";

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: ["ingest", "amend", "pay", "approve", "verify_vendor", "edit_vendor", "invite_vendor", "sign_off", "export", "reconcile", "lock_period", "stop", "resolve_stuck", "build_run", "release_run", "settings", "manage_users", "reset_demo"],
  approver: ["approve", "verify_vendor", "sign_off", "pay", "stop", "resolve_stuck", "release_run", "export"],
  clerk: ["ingest", "amend", "pay", "edit_vendor", "invite_vendor", "stop", "build_run", "export"],
  accountant: ["export", "reconcile", "lock_period"],
};

export function can(role: Role, p: Permission): boolean {
  return GRANTS[role]?.includes(p) ?? false;
}

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as readonly string[]).includes(x);
}

export const ROLE_LABEL: Record<Role, string> = { admin: "Owner (admin)", approver: "Approver", clerk: "AP clerk", accountant: "Accountant" };

/** The demo team. Personas let one browser act as each role on a demo database; never with real money. */
export const DEMO_PERSONAS: ReadonlyArray<{ username: string; name: string; role: Role; limitMinor: number | null }> = [
  { username: "daniel", name: "Daniel (owner)", role: "admin", limitMinor: null },
  { username: "minh", name: "Minh (operations manager)", role: "approver", limitMinor: 100_000 },
  { username: "lan", name: "Lan (AP clerk)", role: "clerk", limitMinor: 0 },
  { username: "thu", name: "Thu (accountant)", role: "accountant", limitMinor: 0 },
];
