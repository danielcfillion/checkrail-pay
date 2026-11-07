"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setPersonaAction } from "@/app/actions";
import { useToast } from "./Toast";
import { personaLabel } from "./persona-label";

export type Persona = { username: string; name: string; role: string };

/** Who is acting, and (on demo databases) a switch to act as another member of the demo team. */
export function WhoAmI({ name, role, username, viaLogin, personas, waiting, vendorChecks = 0, runsToRelease = 0, signOut = false }: { name: string; role: string; username: string; viaLogin?: string; personas: readonly Persona[] | null; waiting: number; vendorChecks?: number; runsToRelease?: number; signOut?: boolean }) {
  return (
    <div className="border-t hairline px-3 py-3 lg:px-5">
      <p className="text-sm" title={viaLogin ? `Signed in as ${name}, demo login ${viaLogin}` : `Signed in as ${name}`}>
        <span className="text-ink-soft">Signed in as </span>
        <span className="font-medium">{name}</span>
        {viaLogin ? <span className="hidden text-ink-soft lg:inline">, demo login {viaLogin}</span> : null}
      </p>
      {signOut ? (
        // A plain form post, so it works without JavaScript and no link on another site can sign someone out.
        <form method="post" action="/api/signout" className="inline">
          <button type="submit" className="link text-sm">
            Sign out
          </button>
        </form>
      ) : null}
      <p className="dense text-ink-soft">
        {role}
        {waiting > 0 ? (
          <>
            {" "}
            · <Link href="/obligations?filter=mine" className="link">{waiting} waiting for you</Link>
          </>
        ) : null}
        {runsToRelease > 0 ? (
          <>
            {" "}
            · <Link href="/runs" className="link">{runsToRelease} run{runsToRelease === 1 ? "" : "s"} to release</Link>
          </>
        ) : null}
        {vendorChecks > 0 ? (
          <>
            {" "}
            · <Link href="/vendors" className="link">{vendorChecks} vendor check{vendorChecks === 1 ? "" : "s"}</Link>
          </>
        ) : null}
      </p>
      {personas ? <RoleSwitch personas={personas} username={username} className="mt-2" /> : null}
    </div>
  );
}

/** The demo's role switch. Used in the sidebar and at the foot of the phone More sheet. */
export function RoleSwitch({ personas, username, className = "" }: { personas: readonly Persona[]; username: string; className?: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <label className={`block ${className}`}>
      <span className="dense text-attention">Demo only: switch role</span>
      <select
        className="field mt-0.5 w-full text-sm"
        style={{ borderColor: "var(--attention)" }}
        value={username}
        disabled={pending}
        onChange={(e) =>
          start(async () => {
            const r = await setPersonaAction(e.target.value);
            toast(r.message, r.ok ? "ok" : "error");
            router.refresh();
          })
        }
      >
        {personas.map((p) => (
          <option key={p.username} value={p.username}>
            {personaLabel(p.name)}
          </option>
        ))}
      </select>
    </label>
  );
}
