import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { attachments, businesses } from "../db/schema";
import { newId, now } from "../domain/ids";
import { readDocument, type ProposedEvidence } from "../ai/documents";

/** Document types the reader understands. Anything else (HTML, SVG, scripts) is refused at upload. */
export const ALLOWED_UPLOAD_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type UploadResult = {
  attachmentId: string;
  name: string;
  reader: "pdf-text" | "plain" | "claude" | "none";
  note: string | null;
  proposed: ProposedEvidence[];
  textPreview: string | null;
};

/** Store an uploaded document, read it, and return the evidence rows it proposes. Nothing is attached to an obligation yet. */
export async function uploadDocument(db: Db, input: { businessId: string; name: string; mimeType: string; bytes: Buffer; actor: string }): Promise<UploadResult> {
  const biz = db.select().from(businesses).where(eq(businesses.id, input.businessId)).get();
  if (!biz) throw new Error("No business configured");
  const mime = (input.mimeType || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_UPLOAD_TYPES.has(mime)) throw new Error(`Upload a PDF, a photo (PNG, JPEG, WebP, GIF) or a plain text file. ${input.mimeType || "This file type"} is not accepted.`);
  if (input.bytes.length > MAX_UPLOAD_BYTES) throw new Error("That file is over 10 MB.");
  const read = await readDocument({ name: input.name, mimeType: input.mimeType, bytes: input.bytes, baseCurrency: biz.baseCurrency });
  const id = newId("att");
  db.insert(attachments)
    .values({
      id,
      businessId: input.businessId,
      obligationId: null,
      name: input.name.slice(0, 120),
      mimeType: mime,
      bytes: input.bytes,
      sizeBytes: input.bytes.length,
      sha256: read.sha256,
      extractedText: read.text,
      reader: read.reader,
      proposedJson: JSON.stringify(read.proposed),
      uploadedBy: input.actor,
      createdAt: now(),
    })
    .run();
  return { attachmentId: id, name: input.name, reader: read.reader, note: read.note, proposed: read.proposed, textPreview: read.text ? read.text.replace(/\s+/g, " ").slice(0, 600) : null };
}
