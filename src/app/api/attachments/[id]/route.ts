import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { attachments } from "@/lib/db/schema";
import { ALLOWED_UPLOAD_TYPES } from "@/lib/engine/attachments";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";

/**
 * Serve an uploaded source document to a signed-in member of the business that holds it. Every role may read the
 * evidence behind a payment (the accountant reads everything), but nobody outside the business, and nobody when the
 * request carries no login while logins are configured. A document of another business answers 404, like a missing
 * one, so ids cannot be probed.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^att_[a-z0-9]+$/i.test(id)) return new Response("Not found", { status: 404 });
  const biz = getBusiness();
  const viewer = await getViewer();
  // The middleware names a viewer on every non-public request (a login, or the owner on an open dev server).
  if (!biz || !viewer) return new Response("Not signed in", { status: 401 });
  const a = getDb().select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.businessId, biz.id))).get();
  if (!a) return new Response("Not found", { status: 404 });
  const safeName = a.name.replace(/[^A-Za-z0-9._-]/g, "_");
  // Only types that cannot run script are shown inline; text is always served as plain text. Everything else downloads.
  const inline = ALLOWED_UPLOAD_TYPES.has(a.mimeType);
  return new Response(new Uint8Array(a.bytes), {
    headers: {
      "Content-Type": !inline ? "application/octet-stream" : a.mimeType === "text/plain" ? "text/plain; charset=utf-8" : a.mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      // Images and text get a sandboxed, script-free CSP. PDFs get none: any CSP can blank Chromium's built-in viewer,
      // and a PDF served as application/pdf with nosniff cannot run script on this origin.
      ...(a.mimeType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }),
      "Content-Length": String(a.sizeBytes),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
