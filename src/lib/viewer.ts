import { headers } from "next/headers";
import { getDb } from "./db";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER, configuredUsers, personasAllowed } from "./basicAuth";
import { DEMO_PERSONAS, isRole, type Permission } from "./auth/roles";
import { actorCan, resolveActor, type Actor } from "./engine/users";
import { getBusiness } from "./queries";


export interface Viewer {
  actor: Actor;
  /** What this person may do, for showing only the buttons that will work. The server checks again on every action. */
  can: (p: Permission) => boolean;
  /** The demo team, when switching persona is allowed here. */
  personas: typeof DEMO_PERSONAS | null;
  /** The real login behind this page (the owner, when acting as a demo persona). Checks that compare people run as it. */
  login: string;
}

/** The person viewing this page, from the headers the middleware set. Null on public pages or with no business. */
export async function getViewer(): Promise<Viewer | null> {
  const h = await headers();
  const username = h.get(ACTOR_HEADER);
  const role = h.get(ROLE_HEADER);
  if (!username || !isRole(role)) return null;
  const biz = getBusiness();
  if (!biz) return null;
  const actor = resolveActor(getDb(), biz.id, username, role, h.get(PERSONA_HEADER) ?? undefined);
  const users = configuredUsers() ?? [];
  // The switch shows for an owner login, including one currently acting as someone else.
  const personasOn = (role === "admin" || h.get(PERSONA_HEADER) !== null) && personasAllowed(process.env, users.length > 0);
  return { actor, can: (p) => actorCan(actor, p), personas: personasOn ? DEMO_PERSONAS : null, login: h.get(PERSONA_HEADER) ?? username };
}

export async function isPublicPage(): Promise<boolean> {
  return (await headers()).get("x-checkrail-public") === "1";
}
