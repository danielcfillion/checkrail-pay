import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { xeroConnections, xeroRecords } from "../db/schema";
import { config } from "../config";
import { audit } from "../domain/stateMachine";
import { createXeroClient, XeroApiError } from "./xeroClient";
import { getXeroConnection, xeroConfigured, xeroRedirectUri, type XeroConnectionRow } from "./xeroAuth";
import { xeroBillRows } from "./xeroBills";
import { splitGroups } from "./xeroScope";

/**
 * The account mapping: which of the organisation's accounts Checkrail posts to. Read from the tenant's chart of
 * accounts, chosen by the owner, stored per business. The chart is cached on the connection so the Settings page
 * never calls Xero to render.
 */

export interface XeroAccount {
  code: string;
  name: string;
  type: string; // BANK, EXPENSE, DIRECTCOSTS, OVERHEADS, CURRLIAB, PREPAYMENT, ...
  currency?: string | null;
}
export interface XeroChart {
  accounts: XeroAccount[];
  taxRates: Array<{ type: string; name: string }>;
  currencies: string[];
  baseCurrency: string | null;
  tracking: Array<{ name: string; options: string[] }>;
}

export const EXPENSE_TYPES = new Set(["EXPENSE", "DIRECTCOSTS", "OVERHEADS"]);

export function parseChart(json: string | null | undefined): XeroChart | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as XeroChart;
  } catch {
    return null;
  }
}

interface RawAccount {
  Code?: string;
  Name: string;
  Type: string;
  Status?: string;
  CurrencyCode?: string;
}

/** Read the chart of accounts, tax rates, currencies and tracking categories (five calls), and fill any unset mapping with a sensible default. */
export async function refreshXeroChart(db: Db, businessId: string): Promise<XeroChart> {
  const conn = getXeroConnection(db, businessId);
  if (!conn) throw new XeroApiError("Xero is not connected.", "auth");
  const client = createXeroClient(db, businessId, conn.tenantId);
  const acc = await client.request<{ Accounts: RawAccount[] }>({ method: "GET", path: "/Accounts" });
  const tax = await client.request<{ TaxRates: Array<{ TaxType: string; Name: string; Status?: string; CanApplyToExpenses?: boolean }> }>({ method: "GET", path: "/TaxRates" });
  const cur = await client.request<{ Currencies: Array<{ Code: string }> }>({ method: "GET", path: "/Currencies" });
  const org = await client.request<{ Organisations: Array<{ BaseCurrency?: string }> }>({ method: "GET", path: "/Organisation" });
  const trk = await client.request<{ TrackingCategories: Array<{ Name: string; Status?: string; Options?: Array<{ Name: string; Status?: string }> }> }>({ method: "GET", path: "/TrackingCategories" });
  const chart: XeroChart = {
    accounts: (acc.Accounts ?? []).filter((a) => a.Code && (a.Status ?? "ACTIVE") === "ACTIVE").map((a) => ({ code: a.Code!, name: a.Name, type: a.Type, currency: a.CurrencyCode ?? null })),
    taxRates: (tax.TaxRates ?? []).filter((t) => (t.Status ?? "ACTIVE") === "ACTIVE" && t.CanApplyToExpenses !== false).map((t) => ({ type: t.TaxType, name: t.Name })),
    currencies: (cur.Currencies ?? []).map((c) => c.Code),
    baseCurrency: org.Organisations?.[0]?.BaseCurrency ?? null,
    tracking: (trk.TrackingCategories ?? []).filter((t) => (t.Status ?? "ACTIVE") === "ACTIVE").map((t) => ({ name: t.Name, options: (t.Options ?? []).filter((o) => (o.Status ?? "ACTIVE") === "ACTIVE").map((o) => o.Name) })),
  };
  const d = defaultMapping(chart);
  const ts = new Date().toISOString();
  db.update(xeroConnections)
    .set({
      chartJson: JSON.stringify(chart),
      chartFetchedAt: ts,
      expenseAccountCode: conn.expenseAccountCode ?? d.expenseAccountCode,
      feeAccountCode: conn.feeAccountCode ?? d.feeAccountCode,
      taxType: conn.taxType ?? d.taxType,
      paypalAccountCode: conn.paypalAccountCode ?? d.paypalAccountCode,
      stellarAccountCode: conn.stellarAccountCode ?? d.stellarAccountCode,
      bankAccountCode: conn.bankAccountCode ?? d.bankAccountCode,
      updatedAt: ts,
    })
    .where(eq(xeroConnections.businessId, businessId))
    .run();
  return chart;
}

/** First guesses: General expenses (429) and Bank fees (404) when the chart has them, the tax rate the bills file uses, bank accounts named after the rail. */
export function defaultMapping(chart: XeroChart) {
  const has = (code: string) => chart.accounts.some((a) => a.code === code);
  const expense = chart.accounts.filter((a) => EXPENSE_TYPES.has(a.type));
  const banks = chart.accounts.filter((a) => a.type === "BANK");
  const named = (re: RegExp) => banks.find((a) => re.test(a.name))?.code ?? null;
  const wanted = (process.env.XERO_TAX_TYPE || "Tax Exempt").toLowerCase();
  const tax = chart.taxRates.find((t) => t.name.toLowerCase().startsWith(wanted)) ?? chart.taxRates.find((t) => t.type === "NONE") ?? chart.taxRates.find((t) => /exempt|no tax|no vat|no gst/i.test(t.name));
  return {
    expenseAccountCode: has("429") ? "429" : (expense[0]?.code ?? null),
    feeAccountCode: has("404") ? "404" : (expense.find((a) => /bank|fee/i.test(a.name))?.code ?? null),
    taxType: tax?.type ?? null,
    paypalAccountCode: named(/paypal/i),
    stellarAccountCode: named(/stellar|treasury|pyusd|usdc/i),
    bankAccountCode: banks.find((a) => !/paypal|stellar|treasury|pyusd|usdc/i.test(a.name))?.code ?? null,
  };
}

export interface XeroMappingInput {
  expenseAccountCode: string | null;
  paypalAccountCode: string | null;
  stellarAccountCode: string | null;
  bankAccountCode: string | null;
  feeAccountCode: string | null;
  taxType: string | null;
}

/** Save the owner's choices, each checked against the cached chart: a bank account for payments, an expense account for bills and fees. */
export function saveXeroMapping(db: Db, businessId: string, actor: string, input: XeroMappingInput): { ok: true } | { ok: false; message: string } {
  const conn = getXeroConnection(db, businessId);
  if (!conn) return { ok: false, message: "Xero is not connected." };
  const chart = parseChart(conn.chartJson);
  if (!chart) return { ok: false, message: "Read the chart of accounts from Xero first." };
  const find = (code: string | null) => (code ? chart.accounts.find((a) => a.code === code) : undefined);
  const checks: Array<[string, string | null, (a: XeroAccount) => boolean]> = [
    ["Supplier bills", input.expenseAccountCode, (a) => EXPENSE_TYPES.has(a.type)],
    ["Payment fees", input.feeAccountCode, (a) => EXPENSE_TYPES.has(a.type)],
    ["PayPal", input.paypalAccountCode, (a) => a.type === "BANK"],
    ["Stellar treasury", input.stellarAccountCode, (a) => a.type === "BANK"],
    ["Wise and bank file", input.bankAccountCode, (a) => a.type === "BANK"],
  ];
  for (const [label, code, ok] of checks) {
    if (!code) continue;
    const a = find(code);
    if (!a) return { ok: false, message: `${label}: account ${code} is not in this Xero organisation's chart of accounts.` };
    if (!ok(a)) return { ok: false, message: `${label}: ${a.code} ${a.name} is the wrong kind of account (${a.type.toLowerCase()}).` };
  }
  // Required: the bill's lines are sent with this rate, so the bill total is exactly what is paid (see xeroSync taxTerms).
  if (!input.taxType) return { ok: false, message: "Tax rate on bills: choose one (Tax Exempt, or No Tax, when you do not reclaim tax on supplier bills)." };
  if (!chart.taxRates.some((t) => t.type === input.taxType)) return { ok: false, message: "That tax rate is not in this Xero organisation." };
  db.update(xeroConnections)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(eq(xeroConnections.businessId, businessId))
    .run();
  audit(db, { obligationId: null, actor, action: "xero.mapping_saved", detail: { ...input } });
  return { ok: true };
}

/** What the Xero card shows. Everything here is safe for the browser: no token, no secret, no tenant credential. */
export interface XeroCardView {
  configured: boolean;
  destination: "csv" | "xero";
  redirectUri: string;
  connected: boolean;
  needsReconnect: boolean;
  tenantName: string | null;
  connectedAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  blockedUntil: string | null;
  mapping: XeroMappingInput;
  chartFetchedAt: string | null;
  bankAccounts: Array<{ code: string; label: string }>;
  expenseAccounts: Array<{ code: string; label: string }>;
  taxRates: Array<{ type: string; name: string }>;
  pushed: number;
  waiting: number;
  failures: Array<{ id: string; label: string; error: string; attempts: number; nextAttemptAt: string | null }>;
  /** Bills approved before Xero was connected: they stay in the bills file and the settlement CSV. */
  earlierBills: number;
}

export function xeroCardView(db: Db, businessId: string): XeroCardView {
  const conn: XeroConnectionRow | null = getXeroConnection(db, businessId);
  const chart = parseChart(conn?.chartJson);
  const label = (a: XeroAccount) => `${a.code} ${a.name}${a.currency ? ` (${a.currency})` : ""}`;
  const tenant = conn?.tenantId ?? "";
  const counts = conn ? db.select({ status: xeroRecords.status }).from(xeroRecords).where(and(eq(xeroRecords.businessId, businessId), eq(xeroRecords.tenantId, tenant), inArray(xeroRecords.kind, ["bill", "credit_note", "payment", "fee"]))).all() : [];
  const failures = conn
    ? db.select().from(xeroRecords).where(and(eq(xeroRecords.businessId, businessId), eq(xeroRecords.tenantId, tenant), eq(xeroRecords.status, "failed"))).orderBy(desc(xeroRecords.updatedAt)).limit(10).all()
    : [];
  return {
    configured: xeroConfigured(),
    destination: config.accounting.destination,
    redirectUri: xeroRedirectUri(),
    connected: Boolean(conn),
    needsReconnect: conn?.status === "needs_reconnect",
    tenantName: conn?.tenantName ?? null,
    connectedAt: conn?.connectedAt ?? null,
    lastPushAt: conn?.lastPushAt ?? null,
    lastError: conn?.lastError ?? null,
    blockedUntil: conn?.blockedUntil && Date.parse(conn.blockedUntil) > Date.now() ? conn.blockedUntil : null,
    mapping: {
      expenseAccountCode: conn?.expenseAccountCode ?? null,
      paypalAccountCode: conn?.paypalAccountCode ?? null,
      stellarAccountCode: conn?.stellarAccountCode ?? null,
      bankAccountCode: conn?.bankAccountCode ?? null,
      feeAccountCode: conn?.feeAccountCode ?? null,
      taxType: conn?.taxType ?? null,
    },
    chartFetchedAt: conn?.chartFetchedAt ?? null,
    bankAccounts: (chart?.accounts ?? []).filter((a) => a.type === "BANK").map((a) => ({ code: a.code, label: label(a) })),
    expenseAccounts: (chart?.accounts ?? []).filter((a) => EXPENSE_TYPES.has(a.type)).map((a) => ({ code: a.code, label: label(a) })),
    taxRates: chart?.taxRates ?? [],
    pushed: counts.filter((c) => c.status === "pushed").length,
    waiting: counts.filter((c) => c.status === "pending").length,
    failures: failures.map((f) => ({ id: f.id, label: f.label, error: f.error ?? "Not sent", attempts: f.attempts, nextAttemptAt: f.nextAttemptAt })),
    earlierBills: conn ? splitGroups(db, xeroBillRows(db, businessId, { onlyNew: true }).groups, conn.syncFrom).earlier.length : 0,
  };
}
