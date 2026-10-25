import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is really at the keyboard for this request. With demo personas an owner login can act as Minh or Lan; the
 * audit actor is then the persona, so every audit row also records the real login, and anything that counts
 * "different people" (dual approval, separation of duties) counts logins, not personas.
 */
const store = new AsyncLocalStorage<{ login: string }>();

/**
 * Run `fn` with this login as the request's real person. Everything `fn` awaits sees it. (Setting it from inside a
 * helper with enterWith does not work: the value stays in the helper's own async context and the caller never sees
 * it, which is how the first version of this silently recorded nothing.)
 */
export function runAs<T>(login: string | null, fn: () => T): T {
  return login ? store.run({ login }, fn) : fn();
}

export function currentLogin(): string | null {
  return store.getStore()?.login ?? null;
}

/** The human behind an audit actor: the real login when a persona is acting, else the actor's own username. */
export function humanOf(actor: string, login: string | null | undefined): string {
  return login ?? (actor.startsWith("user:") ? actor.slice(5) : actor);
}
