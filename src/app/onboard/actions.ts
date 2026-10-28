"use server";

import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { submitOnboarding } from "@/lib/engine/vendors";

/**
 * The only action a vendor can call, from the page their link opens. It needs no login: the single-use token is
 * the credential, and what it can do is narrow. It files a request; a person at the business still verifies it
 * before any money goes there.
 */
export async function submitOnboardingAction(token: string, input: { profile?: unknown; payout: unknown }): Promise<{ ok: boolean; message: string }> {
  try {
    if (typeof token !== "string") throw new Error("This link is not valid.");
    // Keep requests to the vendor page itself; an internal page has no reason to call this.
    if ((await headers()).get("x-checkrail-public") !== "1") throw new Error("Open your link to submit.");
    submitOnboarding(getDb(), token, { profile: input?.profile, payout: input?.payout });
    return { ok: true, message: "Thank you. Your details were sent. The business confirms them with you before the first payment." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
