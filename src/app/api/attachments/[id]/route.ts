import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { attachments } from "@/lib/db/schema";

/** Serve an uploaded source document. Behind the same Basic auth as every page when CHECKRAIL_BASIC_AUTH is set. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^att_[a-z0-9]+$/i.test(id)) return new Response("Not found", { status: 404 });
  const a = getDb().select().from(attachments).where(eq(attachments.id, id)).get();
  if (!a) return new Response("Not found", { status: 404 });
  const safeName = a.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Uint8Array(a.bytes), {
    headers: {
      "Content-Type": a.mimeType.startsWith("image/") || a.mimeType === "application/pdf" || a.mimeType.startsWith("text/") ? a.mimeType : "application/octet-stream",
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Content-Length": String(a.sizeBytes),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
