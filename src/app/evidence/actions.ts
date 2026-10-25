"use server";

import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { submitEvidence } from "@/lib/engine/vendorLinks";

/** The vendor's upload from their evidence link. The single-use token is the credential; a person still reads the file. */
export async function submitEvidenceAction(token: string, form: FormData): Promise<{ ok: boolean; message: string }> {
  try {
    if ((await headers()).get("x-checkrail-public") !== "1") throw new Error("Open your link to upload.");
    const file = form.get("file");
    if (typeof token !== "string" || !(file instanceof File)) throw new Error("Choose a file to send.");
    if (file.size > 10 * 1024 * 1024) throw new Error("That file is over 10 MB.");
    await submitEvidence(getDb(), token, { name: file.name.slice(0, 120), mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    return { ok: true, message: "Thank you. Your document was sent; the business checks it before paying." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
