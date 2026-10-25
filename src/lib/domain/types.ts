/**
 * Core domain types for Checkrail Pay.
 *
 * The AI proposes. Deterministic policy disposes. Rails execute. The audit log remembers.
 */

export const OBLIGATION_STATES = [
  "drafted",
  "needs_evidence",
  "verified",
  "awaiting_approval",
  "approved",
  "blocked",
  "execution_pending",
  "sent",
  "settled",
  "failed",
  "refunded",
  "disputed",
  "cancelled",
] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<ObligationState> = new Set([
  "settled",
  "refunded",
  "cancelled",
]);

/** Allowed state transitions. Anything not listed is rejected by the state machine. */
export const TRANSITIONS: Record<ObligationState, readonly ObligationState[]> = {
  drafted: ["needs_evidence", "verified", "blocked", "cancelled"],
  needs_evidence: ["verified", "blocked", "cancelled"],
  verified: ["awaiting_approval", "approved", "blocked", "cancelled"],
  awaiting_approval: ["approved", "blocked", "cancelled"],
  approved: ["execution_pending", "needs_evidence", "awaiting_approval", "blocked", "cancelled"], // policy can pull an approved obligation back before money moves
  blocked: ["verified", "awaiting_approval", "cancelled"], // after human review, re-enter the flow
  execution_pending: ["sent", "failed"],
  sent: ["settled", "failed", "disputed"],
  settled: ["refunded", "disputed"],
  failed: ["approved", "cancelled"], // retry or give up
  refunded: [],
  disputed: ["settled", "refunded", "cancelled"],
  cancelled: [],
};

export type Rail = "paypal" | "stellar" | "wise" | "bank_file";
export const RAILS: readonly Rail[] = ["paypal", "stellar", "wise", "bank_file"];

export type SourceType = "invoice" | "job_completion" | "operator_instruction" | "booking";

export type PolicyDecision = "auto_execute" | "require_approval" | "block" | "hold";

export interface ApprovalPolicy {
  /** Obligations at or below this amount (in base currency minor units) may auto-execute when evidence matches. */
  autoExecuteThresholdMinor: number;
  /** Obligations above this amount require two approvals. 0 disables. */
  dualApprovalThresholdMinor: number;
  /** Tolerance for amount mismatch between request and evidence, in basis points of the evidence amount. */
  amountToleranceBps: number;
  /** Require evidence before any execution. */
  requireEvidence: boolean;
  /** Block when a vendor's payout details changed since last verification. */
  blockOnRecipientChange: boolean;
  /** Minimum AI confidence (0..100) to proceed without human review. */
  minAiConfidence: number;
  /** Corridors (sender country -> recipient country) the business has enabled. */
  allowedCorridors: string[]; // e.g. ["US->US", "US->PH", "US->VN"]
  /** Rolling 24h total per vendor (committed obligations plus this one) above which a human must approve. 0 disables. */
  vendorDailyCapMinor?: number;
  /**
   * The person who ingested an obligation may not approve it. When unset this is enforced
   * only with RAIL_MODE=live, so the single-operator demo keeps working.
   */
  requireSeparateApprover?: boolean;
  /**
   * How much the agent may do without asking.
   *  review    every payment waits for a person
   *  assist    clean requests under the auto-execute threshold are pre-approved; a person sends them (today's behaviour)
   *  autopilot clean requests within the caps below are sent by the agent after a cancel window
   * Blocks and holds apply at every level. Autonomy only removes the approval step.
   */
  autonomy?: "review" | "assist" | "autopilot";
  /** Autopilot: largest single payment the agent may release alone, in base currency minor units. */
  autopilotPerPaymentCapMinor?: number;
  /** Autopilot: most the agent may release alone across the business in a rolling 24h, in base currency minor units. */
  autopilotDailyCapMinor?: number;
  /** Autopilot: seconds between "scheduled" and money moving, during which a person can cancel. 0 sends immediately. */
  autopilotCancelWindowSeconds?: number;
  /** Autopilot switched off without losing its settings. While true the level behaves as assist. */
  autopilotPaused?: boolean;
  /** The business pays as a Vietnamese entity and withholds 10% personal income tax from individuals paid VND 2,000,000 or more. */
  withholdVnPit?: boolean;
  /** The business pays as a Philippine entity and withholds expanded withholding tax at each payee's rate. */
  withholdPhEwt?: boolean;
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  autoExecuteThresholdMinor: 25_000, // $250
  dualApprovalThresholdMinor: 500_000, // $5,000
  amountToleranceBps: 50, // 0.5%
  requireEvidence: true,
  blockOnRecipientChange: true,
  minAiConfidence: 75,
  allowedCorridors: ["US->US", "US->PH", "US->VN", "US->CA", "US->GB"],
  vendorDailyCapMinor: 100_000, // $1,000 per vendor per rolling 24h
  autonomy: "assist",
  autopilotPerPaymentCapMinor: 50_000, // $500
  autopilotDailyCapMinor: 200_000, // $2,000 across the business per rolling 24h
  autopilotCancelWindowSeconds: 600, // 10 minutes
  autopilotPaused: false,
};

/** The level actually in force: a paused autopilot behaves as assist. */
export function effectiveAutonomy(p: ApprovalPolicy): "review" | "assist" | "autopilot" {
  const level = p.autonomy ?? "assist";
  return level === "autopilot" && p.autopilotPaused ? "assist" : level;
}

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface VendorPayoutProfile {
  id: string;
  name: string;
  country: string;
  preferredRail: Rail | null;
  paypalEmail: string | null;
  stellarAccount: string | null;
  bankCountry: string | null;
  bankCurrency: string | null;
  bankLabel: string | null;
  detailsHash: string;
  verifiedAt: string | null;
  /** "blocked" stops every payment to this vendor until someone unblocks them. */
  status?: string;
  /** A full bank account number is on file (encrypted). The number itself is only read at payment time. */
  hasBankAccount?: boolean;
  bankCode?: string | null;
  accountHolder?: string | null;
}

export interface EvidenceItem {
  id: string;
  kind: string;
  label: string;
  amountMinor: number | null;
  currency: string | null;
  reference: string | null;
  excerpt: string | null;
  /** Who supplied this record. Operator-supplied evidence is untrusted; system evidence comes from an integration. Unset means system. */
  provenance?: "system" | "operator" | "document" | "vendor";
}

/** Output of the AI obligation agent. The agent has no spending authority; it only produces this. */
export interface AiInterpretation {
  vendorName: string | null;
  vendorId: string | null;
  amountMinor: number | null;
  currency: string | null;
  description: string;
  sourceRef: string | null;
  dueDate: string | null;
  summary: string;
  confidence: number; // 0..100
  flags: string[]; // concerns that should hold the payment for a person, in plain language
  missing: string[]; // evidence the agent wants before it would be comfortable
  /** Neutral observations shown to the approver. They never affect policy. */
  notes?: string[];
  /** The request pays part of a larger invoice: a deposit now, the balance of an earlier deposit, or a part payment. */
  paymentPart?: { kind: "deposit" | "balance" | "part"; ofTotalMinor: number | null } | null;
}

export interface PolicyInput {
  /** "advance", "deposit", "balance", "part", "full" for a payment against a bill. */
  paymentKind?: string | null;
  obligation: {
    id: string;
    amountMinor: number | null;
    currency: string | null;
    sourceRef: string | null;
    vendorId: string | null;
  };
  vendor: VendorPayoutProfile | null;
  evidence: EvidenceItem[];
  ai: AiInterpretation | null;
  businessCountry: string;
  baseCurrency: string;
  /**
   * The amount in the base currency at reference rates, for every threshold, cap and limit. Equal to the amount when
   * the obligation is in the base currency; null when there is no rate for its currency.
   */
  baseAmountMinor?: number | null;
  /** Tax kept back from this payment, and a missing tax form (see engine/taxes.ts). */
  withholding?: { rule: string; withheldMinor: number; reason: string } | null;
  taxFormWarning?: string | null;
  /** What the business's own rate card and departure records say this job should cost (see engine/rates.ts). */
  expectation?: { departureCode: string; expectedMinor: number; currency: string; basis: string } | null;
  /** The bill this payment settles all or part of, with what other payments and credits already cover. */
  bill?: { id: string; vendorId: string; reference: string; kind: string; status: string; totalMinor: number; currency: string; coveredMinor: number } | null;
  /** Source refs of other obligations for the same vendor in the lookback window (for duplicate detection). */
  priorSourceRefs: Array<{
    obligationId: string;
    sourceRef: string | null;
    amountMinor: number | null;
    state: ObligationState;
    /** Every identifier that names the underlying job: source ref, evidence refs, trip or job ids found in the text. Lower-cased. */
    keys?: string[];
    /** ISO time of last update, for the same-amount recency check. */
    updatedAt?: string;
    /** Bill the earlier obligation paid against: payments on the same bill are parts of one invoice, not duplicates. */
    billId?: string | null;
  }>;
  /** Business-wide committed payments in base currency over the last 24h, excluding this one. Used by the autopilot daily cap. */
  businessRecentMinor?: number;
  /** Fingerprints (see warningFingerprint) of the warnings the current approvals were given over. A bare rule id, from approvals made before fingerprints, covers every warning of that rule. Undefined means unknown (older approvals): every warning counts as seen. */
  acknowledgedWarnings?: string[];
  /** Other vendors of this business whose payout destination (PayPal email, Stellar account, bank account) is the same as this vendor's. */
  sharedPayoutWith?: string[];
  /** Amounts (base currency, minor units) of this vendor's earlier settled payments. Autopilot holds a first payment or an unusual amount. */
  vendorSettledMinors?: number[];
  /** The raw request text (message, email body). Used to check the request names the payee. */
  requestText?: string;
  /** Every vendor the business knows, for deciding whether a record names the payee or someone else. */
  knownVendorNames?: Array<{ id: string; name: string }>;
  /** Obligations for OTHER vendors (not cancelled or failed) that use this obligation's exact reference. One job reference billed by two payees needs a person. */
  otherVendorRefs?: Array<{ obligationId: string; vendorName: string; reference: string; state: string }>;
  /** Identifiers naming THIS obligation's job (same construction as priorSourceRefs[].keys). */
  jobKeys?: string[];
  /** Number of DISTINCT people who approved. */
  approvalsCount: number;
  /** Total of this vendor's other committed obligations in the last 24h, in minor units. */
  vendorRecentMinor?: number;
}

export interface PolicyRuleResult {
  ruleId: string;
  passed: boolean;
  severity: "info" | "warn" | "block";
  message: string;
  /** What this particular warning is about (another obligation's id, a flag's text). With ruleId it fingerprints the warning for approvals. */
  key?: string;
}

/** Stable identity of one warning: an approval covers exactly the warnings with these fingerprints. */
export function warningFingerprint(r: PolicyRuleResult): string {
  return `${r.ruleId}|${r.key ?? r.message}`;
}

/**
 * Does a set of acknowledged fingerprints cover this one? Exact match, a bare rule id (approvals made before
 * fingerprints), or a seen "other payment committed" covering the same payment now "open": only open to committed
 * is new information. Without that last case two payees approved on one reference would void each other forever.
 */
export function fingerprintCovered(seen: Set<string>, fp: string): boolean {
  if (seen.has(fp) || seen.has(fp.split("|")[0])) return true;
  return fp.endsWith(":open") && seen.has(fp.replace(/:open$/, ":committed"));
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  reasons: string[];
  rules: PolicyRuleResult[];
  /** Warnings that were not on screen when the existing approval was given. Their presence voids that approval. */
  unacknowledged?: string[];
}

export interface RouteQuote {
  rail: Rail;
  available: boolean;
  unavailableReason?: string;
  sendAmountMinor: number;
  sendCurrency: string;
  feeMinor: number;
  fxRate: string; // decimal string, 1 send unit -> receive units
  receiveAmountMinor: number;
  receiveCurrency: string;
  etaSeconds: number;
  corridor: string;
  provider: string;
  explanation: string;
  /** True when part of the quote (swap, anchor off-ramp, recipient-currency delivery) is an estimate Checkrail Pay does not execute. */
  modelled?: boolean;
}

export interface ExecutionRequest {
  obligationId: string;
  idempotencyKey: string;
  vendor: VendorPayoutProfile;
  amountMinor: number;
  currency: string;
  memo: string; // short reference that appears on the payment
  /** Sender country for corridor figures. Defaults to US. */
  businessCountry?: string;
  /** Full bank account number, decrypted for this one request. Only set for bank rails (Wise, bank file). */
  bankAccountNumber?: string;
  /** Business that owns the payment, for rails that keep their own records (the bank file). */
  businessId?: string;
  /**
   * Called with the provider-side id (Stellar tx hash) after the request is built and
   * before it is sent, so the engine can persist it. If the send then has an unknown
   * outcome the payment can still be found by that id.
   */
  beforeSubmit?: (info: { externalId: string }) => void;
}

export interface ExecutionResult {
  /**
   * submitted/confirmed: the provider accepted it.
   * failed: the provider definitively rejected it, nothing moved, a retry is safe.
   * unknown: ambiguous (timeout, 5xx, lost response). Money may have moved; never retry with a new key.
   */
  status: "submitted" | "confirmed" | "failed" | "unknown";
  externalId: string | null;
  externalStatus: string | null;
  explorerUrl?: string | null;
  feeMinor: number;
  receivedMinor: number | null;
  receivedCurrency: string | null;
  fxRate: string | null;
  raw: unknown;
  errorMessage?: string;
  /** Free-text caveat stored on the settlement (for example that a figure is modelled). */
  note?: string | null;
}

export interface SettlementStatus {
  /** exception: the provider needs a human (for example an unclaimed PayPal payout). Funds may still be claimed, so this is not a failure. */
  status: "pending" | "confirmed" | "failed" | "exception";
  message?: string;
  externalStatus: string | null;
  explorerUrl?: string | null;
  raw: unknown;
}

/**
 * Every payment rail implements this. Adding a rail means adding an adapter,
 * not touching the engine. Adapters never decide whether to pay; they only quote,
 * execute an already-authorised request, and report status.
 */
export interface PaymentRail {
  readonly rail: Rail;
  readonly mode: "mock" | "sandbox" | "testnet" | "live";
  quote(input: {
    vendor: VendorPayoutProfile;
    amountMinor: number;
    currency: string;
    businessCountry: string;
  }): Promise<RouteQuote>;
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
  getStatus(externalId: string): Promise<SettlementStatus>;
  /** Optional: does the provider already know this idempotency key? Used to reconcile an attempt whose outcome was unknown before replaying it. */
  findByIdempotencyKey?(key: string): Promise<{ batchId: string; batchStatus: string | null } | null>;
  /** Optional: does this provider id belong to the attempt with this idempotency key? null when the provider could not be asked. */
  externalIdMatchesKey?(externalId: string, key: string): Promise<boolean | null>;
  /** Optional: money available to send in this currency. null when the provider cannot be asked (no permission, outage). */
  balance?(currency: string): Promise<RailBalance | null>;
}

export interface RailBalance {
  availableMinor: number;
  currency: string;
  /** "provider" = read from the account just now; "simulated" = mock rails. */
  source: "provider" | "simulated";
}
