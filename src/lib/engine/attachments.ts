import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { attachments, businesses } from "../db/schema";
import { newId, now } from "../domain/ids";
import { readDocument, type ProposedEvidence } from "../ai/documents";

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
  const read = await readDocument({ name: input.name, mimeType: input.mimeType, bytes: input.bytes, baseCurrency: biz.baseCurrency });
  const id = newId("att");
  db.insert(attachments)
    .values({
      id,
      businessId: input.businessId,
      obligationId: null,
      name: input.name.slice(0, 120),
      mimeType: input.mimeType || "application/octet-stream",
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
