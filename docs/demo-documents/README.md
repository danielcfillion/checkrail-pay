# Demo documents

Fictional paperwork from Ridgeline Expeditions' vendors, for uploading on camera at `/obligations/new`. All names, companies and amounts are invented.

| File | What happens when uploaded | Why |
|---|---|---|
| `tripsheet-ceb2d-1024.pdf` | Ready to pay. Rosa Villanueva, departure CEB-2D-1024, 2 days at USD 95, USD 190. Rosa's rate card and the departure are on file, so the business's own records confirm the amount. Ready to pay on Assist; scheduled and sent by autopilot on Autopilot (PayPal only: Rosa has no Stellar wallet). | The autopilot shot in /demo and the video. |
| `tripsheet-hg5d-1005.pdf` | Awaiting approval. Maria Santos, 5 days at USD 45, USD 225. Departure HG-5D-1005 is not on file, so only the uploaded sheet supports the amount. | Shows that an uploaded document alone is not independent support. |
| `invoice-rosa-0942.pdf` | Awaiting approval. Rosa Villanueva, two day trips, USD 205. A vendor's own invoice always goes to a person, even on Autopilot. | The vendor's claim, not the business's record. |
| `invoice-bayan-0944.pdf` | Held for a person: USD 640 is above the auto threshold. With Claude live, the agent's vendor_history tool shows earlier charters at USD 130 and it flags the USD 160 rate. | A real rate change, read by the agent, decided by a person. |
| `invoice-tam-0834b.pdf` | Blocked. A re-issued copy of INV-TAM-0834 (paid 38 days earlier) under the new number INV-TAM-0834-B. The document text and the re-issue suffix both tie it to the paid job. | Duplicate caught across a renamed invoice. |

Type a covering message that names the vendor, for example "Trip sheet attached for Rosa, please pay." or "Invoice attached from Bayan for last week's charters, please pay.", then upload the file and create the request. If the message names no one, the reader takes the vendor from the document only when exactly one vendor is named there in full, and asks a person to confirm the payee: a supplier's invoice often names the guide or a place that shares a word with another vendor.

Verified 29 Oct 2026 by `src/lib/engine/demoGuide.test.ts`, which runs the /demo guide in order with the rule-based reader and a covering message naming the vendor: Rosa's trip sheet ready to pay and sent by autopilot after the cancel window; Rosa's invoice, Maria's HG-5D-1005 sheet and Bayan's charter awaiting approval; Tam's re-issue blocked.
