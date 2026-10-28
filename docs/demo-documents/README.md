# Demo documents

Fictional paperwork from Ridgeline Expeditions' vendors, for uploading on camera at `/obligations/new`. All names, companies and amounts are invented.

| File | What happens when uploaded | Why |
|---|---|---|
| `tripsheet-hg5d-1005.pdf` | Clean. Maria Santos, 5 days at her USD 45 rate, USD 225. Pre-approved on Assist, sent by autopilot on Autopilot. | The happy path. |
| `invoice-rosa-0942.pdf` | Clean. Rosa Villanueva, two day trips, USD 205. | A second clean one from a different vendor. |
| `invoice-bayan-0944.pdf` | Held for a person: USD 640 is above the auto threshold. With Claude live, the agent's vendor_history tool shows earlier charters at USD 130 and it flags the USD 160 rate. | A real rate change, read by the agent, decided by a person. |
| `invoice-tam-0834b.pdf` | Blocked. A re-issued copy of INV-TAM-0834 (paid 38 days ago) under the new number INV-TAM-0834-B. The document text and the re-issue suffix both tie it to the paid job. | Duplicate caught across a renamed invoice. |

Type a covering message that names the vendor, for example "Invoice attached from Rosa, please pay." or "Invoice attached from Bayan for last week's charters, please pay.", then upload the file and create the obligation. If the message names no one, the reader takes the vendor from the document only when exactly one vendor is named there in full, and asks a person to confirm the payee: a supplier's invoice often names the guide or a place that shares a word with another vendor.

Verified 16 Oct 2026 by running all four through the pipeline with the rule-based reader and a covering message naming the vendor: approved, approved, awaiting approval, blocked.
