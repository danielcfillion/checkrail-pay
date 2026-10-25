import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { downloadBatch } from "@/lib/engine/bankFiles";

/**
 * Download one bank file. It holds full account numbers, so it is served only to someone who may send payments,
 * never cached, and the download is recorded. Downloading freezes the file (see downloadBatch).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  const biz = getBusiness();
  if (!viewer || !biz) return new Response("Not signed in", { status: 401 });
  try {
    const { filename, csv } = downloadBatch(getDb(), biz.id, viewer.actor, id);
    return new Response("﻿" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
  } catch (e) {
    return new Response((e as Error).message, { status: 403 });
  }
}
