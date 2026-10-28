"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setPersonaAction } from "@/app/actions";
import { useToast } from "./Toast";

type Persona = { username: string; name: string; role: string };

/** Who is acting, and (on demo databases) a switch to act as another member of the demo team. */
export function WhoAmI({ name, role, username, viaLogin, personas, waiting, vendorChecks = 0, runsToRelease = 0 }: { name: string; role: string; username: string; viaLogin?: string; personas: readonly Persona[] | null; waiting: number; vendorChecks?: number; runsToRelease?: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <div className="border-t hairline px-3 py-3 lg:px-5">
      <p className="dense text-ink-soft">Signed in as</p>
      <p className="truncate text-sm font-medium" title={viaLogin ? `${name}, via login ${viaLogin}` : name}>
        {name}
      </p>
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
      {personas ? (
        <label className="mt-2 block">
          <span className="dense text-attention">Demo only: switch role</span>
          <select
            className="field mt-0.5 w-full text-sm"
            style={{ borderColor: "var(--attention)" }}
            value={username}
            disabled={pending}
            onChange={(e) =>
              start(async () => {
                const r = await setPersonaAction(e.target.value === viaLogin ? null : e.target.value);
                toast(r.message, r.ok ? "ok" : "error");
                router.refresh();
              })
            }
          >
            {viaLogin && !personas.some((p) => p.username === viaLogin) ? <option value={viaLogin}>{viaLogin} (your login)</option> : null}
            {personas.map((p) => (
              <option key={p.username} value={p.username}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
