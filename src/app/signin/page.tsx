import type { Metadata } from "next";
import { PublicFrame } from "@/components/PublicFrame";
import { safeNext } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  wrong: "That username and password do not match a login. Check both and try again.",
  throttled: "Too many wrong passwords from this address. Wait 15 minutes and try again.",
  unavailable: "Sign-in is not set up on this server yet. Ask the person who runs it.",
  invalid: "The form could not be read. Try again.",
};

/**
 * The sign-in page. A plain form posting to /api/signin, so it works with JavaScript off and in embedded browsers
 * that never show a password prompt. Rendered bare: the middleware marks it public, so no navigation or data loads.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNext(one(sp.next));
  const error = ERRORS[one(sp.error) ?? ""];
  return (
    <PublicFrame>
      <div className="panel mt-[8vh] p-6">
        <p className="text-lg font-semibold tracking-tight">Checkrail Pay</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-ink-soft">Checks every supplier payment before money moves. For the hosted demo, the login is in the Devpost testing instructions.</p>
        {error ? (
          <p role="alert" className="mt-4 rounded bg-blocked-soft px-3 py-2 text-sm text-blocked">
            {error}
          </p>
        ) : null}
        <form method="post" action="/api/signin" className="mt-5 space-y-4">
          <input type="hidden" name="next" value={next} />
          <label className="block">
            <span className="dense text-ink-soft">Username</span>
            <input name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} className="field mt-1 w-full" autoFocus />
          </label>
          <label className="block">
            <span className="dense text-ink-soft">Password</span>
            <input name="password" type="password" autoComplete="current-password" required maxLength={256} className="field mt-1 w-full" />
          </label>
          <button type="submit" className="btn btn-primary w-full">
            Sign in
          </button>
        </form>
        <p className="mt-4 text-sm text-ink-soft">You stay signed in on this browser for 12 hours.</p>
      </div>
    </PublicFrame>
  );
}
