import { sqliteTable, text, integer, index, uniqueIndex, blob } from "drizzle-orm/sqlite-core";

/**
 * Dueline data model.
 *
 * Money is stored as integer minor units (cents) plus an ISO currency code.
 * All timestamps are ISO-8601 strings in UTC.
 * JSON columns hold small, non-queried structures (preferences, quotes, policy).
 */

export const businesses = sqliteTable("businesses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().default("USD"),
  country: text("country").notNull().default("US"),
  policyJson: text("policy_json").notNull(), // ApprovalPolicy
  createdAt: text("created_at").notNull(),
});

export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(), // guide, driver, homestay, creator, supplier, contractor
  country: text("country").notNull(),
  email: text("email"),
  // payout preferences
  preferredRail: text("preferred_rail"), // paypal | stellar | null
  paypalEmail: text("paypal_email"),
  stellarAccount: text("stellar_account"),
  bankCountry: text("bank_country"),
  bankCurrency: text("bank_currency"),
  bankLabel: text("bank_label"), // e.g. "BDO ****1234", never full account numbers
  detailsHash: text("details_hash").notNull(), // hash of payout details; change triggers reverification
  verifiedAt: text("verified_at"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

export const obligations = sqliteTable(
  "obligations",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    vendorId: text("vendor_id"),
    state: text("state").notNull(), // ObligationState
    sourceType: text("source_type").notNull(), // invoice | job_completion | operator_instruction | booking
    sourceRef: text("source_ref"), // e.g. INV-2026-0142, JOB-HG-4D-0921
    rawInput: text("raw_input").notNull(), // the messy text/record the AI interpreted
    description: text("description"),
    amountMinor: integer("amount_minor"),
    currency: text("currency"),
    dueDate: text("due_date"),
    // AI interpretation output
    aiSummary: text("ai_summary"),
    aiConfidence: integer("ai_confidence"), // 0..100
    aiFlagsJson: text("ai_flags_json"), // string[]
    aiMissingJson: text("ai_missing_json"), // string[]
    // policy outcome
    policyDecision: text("policy_decision"), // auto_execute | require_approval | block | hold
    policyReasonsJson: text("policy_reasons_json"), // string[]
    // routing
    selectedRail: text("selected_rail"), // paypal | stellar
    routeReason: text("route_reason"),
    // outcome
    blockedReason: text("blocked_reason"),
    // hash of the vendor's payout details at the moment the obligation was approved; execution refuses if they changed since
    payoutHash: text("payout_hash"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("obligations_business_state").on(t.businessId, t.state)]
);

export const evidence = sqliteTable("evidence", {
  id: text("id").primaryKey(),
  obligationId: text("obligation_id").notNull(),
  kind: text("kind").notNull(), // contract | booking | job_sheet | invoice | message | photo
  label: text("label").notNull(),
  // what the evidence says, structured where possible
  amountMinor: integer("amount_minor"),
  currency: text("currency"),
  reference: text("reference"),
  excerpt: text("excerpt"), // short text excerpt shown in the UI
  provenance: text("provenance"), // system | operator | document (null = system)
  attachmentId: text("attachment_id"), // set when the row was read out of an uploaded document
  createdAt: text("created_at").notNull(),
});

/** Uploaded source documents (PDF, image, text). The bytes stay here; the evidence rows read from them point back. */
export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  obligationId: text("obligation_id"), // null until the obligation is created
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  extractedText: text("extracted_text"), // what the reader got out of it, if anything
  reader: text("reader").notNull(), // pdf-text | plain | claude | none
  proposedJson: text("proposed_json").notNull(), // evidence rows proposed from the document, as extracted
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  obligationId: text("obligation_id").notNull(),
  actor: text("actor").notNull(), // user id or "policy:auto"
  decision: text("decision").notNull(), // approved | rejected
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

export const routeQuotes = sqliteTable("route_quotes", {
  id: text("id").primaryKey(),
  obligationId: text("obligation_id").notNull(),
  rail: text("rail").notNull(),
  available: integer("available", { mode: "boolean" }).notNull(),
  unavailableReason: text("unavailable_reason"),
  sendAmountMinor: integer("send_amount_minor"),
  sendCurrency: text("send_currency"),
  feeMinor: integer("fee_minor"),
  fxRate: text("fx_rate"), // decimal string
  receiveAmountMinor: integer("receive_amount_minor"),
  receiveCurrency: text("receive_currency"),
  etaSeconds: integer("eta_seconds"),
  corridor: text("corridor"), // e.g. "US->PH bank via anchor"
  provider: text("provider"), // e.g. "PayPal Payouts", "Stellar anchor: <name>"
  explanation: text("explanation"),
  createdAt: text("created_at").notNull(),
});

export const paymentAttempts = sqliteTable(
  "payment_attempts",
  {
    id: text("id").primaryKey(),
    obligationId: text("obligation_id").notNull(),
    rail: text("rail").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull(), // pending | submitted | confirmed | failed
    externalId: text("external_id"), // PayPal batch id / Stellar tx hash
    externalStatus: text("external_status"),
    requestJson: text("request_json"),
    responseJson: text("response_json"),
    errorMessage: text("error_message"),
    mode: text("mode").notNull(), // mock | sandbox | testnet | live
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("attempts_obligation").on(t.obligationId)]
);

export const settlements = sqliteTable("settlements", {
  id: text("id").primaryKey(),
  obligationId: text("obligation_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  rail: text("rail").notNull(),
  grossMinor: integer("gross_minor").notNull(),
  grossCurrency: text("gross_currency").notNull(),
  feeMinor: integer("fee_minor").notNull(),
  receivedMinor: integer("received_minor"),
  receivedCurrency: text("received_currency"),
  fxRate: text("fx_rate"),
  externalId: text("external_id"),
  explorerUrl: text("explorer_url"),
  note: text("note"), // caveats, for example that a figure is modelled rather than reported by the provider
  settledAt: text("settled_at").notNull(),
});

export const accountingSyncs = sqliteTable("accounting_syncs", {
  id: text("id").primaryKey(),
  obligationId: text("obligation_id").notNull(),
  destination: text("destination").notNull(), // csv | xero | quickbooks
  status: text("status").notNull(), // pending | exported | synced | failed
  externalRef: text("external_ref"),
  payloadJson: text("payload_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(), // paypal_webhook | stellar_stream | poll | system
    externalEventId: text("external_event_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    processedAt: text("processed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("events_external_event_id_unique").on(t.externalEventId)]
);

export const auditEntries = sqliteTable(
  "audit_entries",
  {
    id: text("id").primaryKey(),
    obligationId: text("obligation_id"),
    seq: integer("seq").notNull(), // monotonically increasing per DB
    actor: text("actor").notNull(), // "ai:obligation-agent" | "policy" | "router" | "rail:paypal" | "user:<id>" | "system"
    action: text("action").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    detailJson: text("detail_json"), // evidence used, policy rule ids, route reason, etc.
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("audit_obligation").on(t.obligationId), uniqueIndex("audit_seq_unique").on(t.seq)]
);
