import { sqliteTable, text, integer, index, uniqueIndex, blob } from "drizzle-orm/sqlite-core";

/**
 * Checkrail Pay data model.
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
  lockedThrough: text("locked_through"), // books closed up to and including this date: nothing dated then changes
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
  status: text("status").notNull().default("active"), // active | blocked
  verifiedBy: text("verified_by"), // who checked the payout details (never the person who entered them)
  verificationMethod: text("verification_method"), // callback | penny_test | in_person | document | onboarding_confirmed
  createdBy: text("created_by"),
  defaultAccountCode: text("default_account_code"),
  bankAccountEnc: text("bank_account_enc"), // full account number, AES-GCM with CHECKRAIL_DATA_KEY; never shown whole
  bankCode: text("bank_code"), // e.g. VCB, TCB, BIDV, BDO
  accountHolder: text("account_holder"), // name on the bank account, as the bank has it
  taxType: text("tax_type"), // individual | business
  paymentTermsDays: integer("payment_terms_days"), // default terms when an invoice states none
  phone: text("phone"), // the number a verifier calls back on; changing it needs an approver
  taxId: text("tax_id"), // MST (VN), TIN (PH, US): for the books and tax reports
  retainerMinor: integer("retainer_minor"), // a fixed amount billed every month (in the vendor's invoice currency)
  taxForm: text("tax_form"), // w9 | w8ben | w8bene | vn_08 | none: which form is on file (the form itself, never an ID number)
  taxFormAt: text("tax_form_at"),
  withholdingBps: integer("withholding_bps"), // Philippine EWT rate for this payee, set by the accountant
});

/** People who use the app. Logins come from configuration; this table holds what the app needs to know about them. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // the login username
  businessId: text("business_id").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(), // admin | approver | clerk | accountant
  approvalLimitMinor: integer("approval_limit_minor"), // base currency; null = no limit (admins)
  delegateTo: text("delegate_to"), // username covering this person's approvals while they are away
  delegateUntil: text("delegate_until"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

/**
 * A proposed change to a vendor: a new vendor, or new payout details for an existing one. Payout details never
 * change in place: they wait here until a second person verifies them (maker-checker), then they apply.
 */
export const vendorChanges = sqliteTable(
  "vendor_changes",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    vendorId: text("vendor_id"),
    kind: text("kind").notNull(), // create | payout
    proposedJson: text("proposed_json").notNull(),
    source: text("source").notNull(), // operator | onboarding
    requestedBy: text("requested_by").notNull(),
    requestedLogin: text("requested_login"), // the real login when a demo persona asked
    status: text("status").notNull(), // pending | approved | rejected
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    method: text("method"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("vendor_changes_business_status").on(t.businessId, t.status)]
);

/** A single-use onboarding link sent to a vendor. Only a hash of the token is stored. */
export const vendorInvites = sqliteTable(
  "vendor_invites",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    vendorId: text("vendor_id"),
    label: text("label"),
    createdBy: text("created_by").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("vendor_invites_token_hash_unique").on(t.tokenHash)]
);

export const obligations = sqliteTable(
  "obligations",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    vendorId: text("vendor_id"),
    billId: text("bill_id"), // the bill this pays all or part of
    paymentKind: text("payment_kind"), // full | deposit | balance | part | advance
    xeroBillExportedAt: text("xero_bill_exported_at"),
    withheldMinor: integer("withheld_minor"), // tax kept back and paid to the tax office instead of the vendor
    withholdingNote: text("withholding_note"), // when this payment's bill went out in a Xero bills import file
    state: text("state").notNull(), // ObligationState
    sourceType: text("source_type").notNull(), // invoice | job_completion | operator_instruction | booking
    sourceRef: text("source_ref"), // e.g. INV-2026-0142, JOB-HG-4D-0921
    rawInput: text("raw_input").notNull(), // the messy text/record the AI interpreted
    description: text("description"),
    amountMinor: integer("amount_minor"),
    currency: text("currency"),
    dueDate: text("due_date"),
    invoiceDate: text("invoice_date"), // the date on the invoice, read from it or set by a person
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
    // Autopilot: when the agent will release this payment (end of the cancel window), and when a person cancelled that release.
    releaseAt: text("release_at"),
    autopilotCancelledAt: text("autopilot_cancelled_at"),
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
  supersededBy: text("superseded_by"), // a revised copy from the vendor replaced this one; kept, but no longer checked
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
  decision: text("decision").notNull(), // approved | rejected | superseded
  note: text("note"),
  acknowledgedJson: text("acknowledged_json"), // warning rule ids on screen when the person approved; null on rows from before 0004
  login: text("login"), // the real login behind the approval (differs from actor when a demo persona approved)
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
  reconciledAt: text("reconciled_at"), // matched to a line on the provider's statement
  statementRef: text("statement_ref"), // that line's transaction id
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

/**
 * A payment run: the week's approved bills, reviewed as one list, funded and released once. Each item still pays
 * through the normal execute path (policy re-runs, idempotency key, pinned payout details); the run only decides
 * which ones and when.
 */
export const paymentRuns = sqliteTable(
  "payment_runs",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(), // draft | releasing | released | cancelled
    createdBy: text("created_by").notNull(),
    createdLogin: text("created_login"),
    releasedBy: text("released_by"),
    releasedAt: text("released_at"),
    cancelledBy: text("cancelled_by"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("payment_runs_business_status").on(t.businessId, t.status)]
);

export const paymentRunItems = sqliteTable(
  "payment_run_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    obligationId: text("obligation_id").notNull(),
    amountMinor: integer("amount_minor").notNull(), // as reviewed when added; a changed obligation is skipped
    currency: text("currency").notNull(),
    rail: text("rail"),
    status: text("status").notNull(), // queued | paid | skipped | failed | unclear
    message: text("message"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("payment_run_items_run").on(t.runId), index("payment_run_items_obligation").on(t.obligationId)]
);

/**
 * Domestic bank bulk-payment files (Vietcombank, Techcombank and BIDV corporate banking all take one). A payment
 * routed to the bank file joins the open batch; someone downloads the file, uploads it to the bank, and confirms
 * it once the bank shows it paid. Until then the payment is "sent", never "settled".
 */
export const bankBatches = sqliteTable("bank_batches", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(), // open | downloaded | confirmed
  sourceAccount: text("source_account").notNull(),
  createdAt: text("created_at").notNull(),
  downloadedAt: text("downloaded_at"),
  downloadedBy: text("downloaded_by"),
  confirmedAt: text("confirmed_at"),
  confirmedBy: text("confirmed_by"),
  bankRef: text("bank_ref"), // the bank's own reference for the upload, from its result screen or statement
});

export const bankBatchLines = sqliteTable(
  "bank_batch_lines",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    obligationId: text("obligation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    beneficiaryName: text("beneficiary_name").notNull(),
    bankCode: text("bank_code").notNull(),
    accountEnc: text("account_enc").notNull(),
    memo: text("memo").notNull(),
    status: text("status").notNull(), // queued | paid | returned
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("bank_batch_lines_key_unique").on(t.idempotencyKey), index("bank_batch_lines_batch").on(t.batchId)]
);

/**
 * What the business owes a vendor, apart from any one payment: an invoice (paid in one go, or as a deposit and a
 * balance), a credit note the vendor issued, or a cash advance given before a trip and settled against receipts.
 * A bill's open amount is its total less what payments against it have committed and less credits applied to it.
 */
export const bills = sqliteTable(
  "bills",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    kind: text("kind").notNull(), // invoice | credit_note | advance
    reference: text("reference").notNull(),
    totalMinor: integer("total_minor").notNull(),
    currency: text("currency").notNull(),
    billDate: text("bill_date"),
    dueDate: text("due_date"),
    status: text("status").notNull(), // open | closed | void
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    xeroExportedAt: text("xero_exported_at"),
  },
  (t) => [index("bills_vendor").on(t.vendorId), uniqueIndex("bills_vendor_ref_kind_unique").on(t.vendorId, t.reference, t.kind)]
);

/** Part of a credit note (or an over-advance the vendor owes back) set against a bill. */
export const billAllocations = sqliteTable("bill_allocations", {
  id: text("id").primaryKey(),
  creditBillId: text("credit_bill_id").notNull(),
  billId: text("bill_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

/** What a vendor charges per unit, for a period. The expected-amount rule multiplies it by a departure's quantities. */
export const rateCards = sqliteTable("rate_cards", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  vendorId: text("vendor_id").notNull(),
  unit: text("unit").notNull(), // day | vehicle_day | guest_night | room_night | guest | trip
  rateMinor: integer("rate_minor").notNull(),
  currency: text("currency").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  note: text("note"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

/** A departure (one run of a tour), from the booking system or a manifest import: dates, guests, and who serves it. */
export const departures = sqliteTable(
  "departures",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    code: text("code").notNull(), // e.g. HG-4D-0927
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    guests: integer("guests").notNull(),
    source: text("source").notNull(), // csv | manual | booking_system
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("departures_business_code_unique").on(t.businessId, t.code)]
);

export const departureServices = sqliteTable(
  "departure_services",
  {
    id: text("id").primaryKey(),
    departureId: text("departure_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    unit: text("unit").notNull(),
    quantity: integer("quantity").notNull(),
  },
  (t) => [index("departure_services_departure").on(t.departureId)]
);

/** One statement reconciliation: what matched, what the statement has that the app does not, and the reverse. */
export const reconciliations = sqliteTable("reconciliations", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  source: text("source").notNull(), // paypal_csv
  fileName: text("file_name"),
  periodFrom: text("period_from"),
  periodTo: text("period_to"),
  summaryJson: text("summary_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Links sent to a vendor about one payment: a remittance advice to view, or a request to upload missing evidence. */
export const vendorLinks = sqliteTable(
  "vendor_links",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    kind: text("kind").notNull(), // remittance | evidence
    tokenHash: text("token_hash").notNull(),
    obligationId: text("obligation_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    note: text("note"),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("vendor_links_token_hash_unique").on(t.tokenHash)]
);
