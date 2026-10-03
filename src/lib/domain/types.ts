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
  approved: ["execution_pending", "blocked", "cancelled"],
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
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  autoExecuteThresholdMinor: 25_000, // $250
  dualApprovalThresholdMinor: 500_000, // $5,000
  amountToleranceBps: 50, // 0.5%
  requireEvidence: true,
  blockOnRecipientChange: true,
  minAiConfidence: 75,
  allowedCorridors: ["US->US", "US->PH", "US->VN", "US->CA", "US->GB"],
};

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
  priorSourceRefs: Array<{ obligationId: string; sourceRef: string | null; amountMinor: number | null; state: ObligationState }>;
  approvalsCount: number;
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
}

export interface ExecutionRequest {
  obligationId: string;
  idempotencyKey: string;
  vendor: VendorPayoutProfile;
  amountMinor: number;
  currency: string;
  memo: string; // short reference that appears on the payment
}

export interface ExecutionResult {
  status: "submitted" | "confirmed" | "failed";
  externalId: string | null;
  externalStatus: string | null;
  explorerUrl?: string | null;
  feeMinor: number;
  receivedMinor: number | null;
  receivedCurrency: string | null;
  fxRate: string | null;
  raw: unknown;
  errorMessage?: string;
}

export interface SettlementStatus {
  status: "pending" | "confirmed" | "failed";
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
