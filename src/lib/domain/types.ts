/**
 * Core domain types for Dueline.
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

export type Rail = "paypal" | "stellar";
export const RAILS: readonly Rail[] = ["paypal", "stellar"];

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
  provenance?: "system" | "operator";
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
  flags: string[]; // anomalies the agent noticed, in plain language
  missing: string[]; // evidence the agent wants before it would be comfortable
}

export interface PolicyInput {
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
  }>;
  /** Business-wide committed payments in base currency over the last 24h, excluding this one. Used by the autopilot daily cap. */
  businessRecentMinor?: number;
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
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  reasons: string[];
  rules: PolicyRuleResult[];
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
  /** True when part of the quote (swap, anchor off-ramp, recipient-currency delivery) is an estimate Dueline does not execute. */
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
}
