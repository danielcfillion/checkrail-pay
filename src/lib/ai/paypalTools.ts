import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { fetchPayPalAccessToken } from "../rails/paypalAuth";

/**
 * PayPal tools exposed to the obligation agent.
 *
 * Read-only by construction: three GET endpoints, called directly over REST (the PayPal Agent Toolkit was dropped:
 * it pulled in a large dependency tree for three read calls). The agent can check PayPal's own records (has this
 * vendor already been paid? does this invoice exist?) and nothing else. There is no tool that moves money, and
 * every argument is validated and URL-encoded here, so the model cannot reach any other endpoint or method.
 */

export interface AgentTool {
  definition: Anthropic.Tool;
  run(args: Record<string, unknown>): Promise<string>;
}

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/;
const MAX_RESULT_CHARS = 6000;

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
}

/** Transaction search allows at most 31 days per query. Default: the last 30 days. */
function dateRange(args: Record<string, unknown>): { start: string; end: string } {
  const endD = typeof args.end_date === "string" && ISO.test(args.end_date) ? new Date(args.end_date) : new Date();
  let startD = typeof args.start_date === "string" && ISO.test(args.start_date) ? new Date(args.start_date) : new Date(endD.getTime() - 30 * 86_400_000);
  if (endD.getTime() - startD.getTime() > 31 * 86_400_000) startD = new Date(endD.getTime() - 31 * 86_400_000);
  if (startD > endD) startD = new Date(endD.getTime() - 86_400_000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
  return { start: iso(startD), end: iso(endD) };
}

export async function loadPayPalTools(): Promise<AgentTool[]> {
  const { clientId, clientSecret, env } = config.rails.paypal;
  if (config.rails.mode !== "live" || !clientId || !clientSecret) return mockPayPalTools();
  const base = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const get = async (path: string): Promise<string> => {
    try {
      const { token } = await fetchPayPalAccessToken(clientId, clientSecret, env);
      const res = await fetch(`${base}${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      const body = res.ok ? text : JSON.stringify({ error: `HTTP ${res.status}`, detail: text.slice(0, 500) });
      return body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : body;
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message.slice(0, 200) });
    }
  };
  return [
    {
      definition: {
        name: "paypal_list_transactions",
        description: "List this business's PayPal transactions in a date range (at most 31 days; default the last 30). Use it to check whether a vendor was already paid for a job.",
        input_schema: { type: "object", properties: { start_date: { type: "string", description: "ISO date or timestamp" }, end_date: { type: "string", description: "ISO date or timestamp" } } },
      },
      run: async (args) => {
        const { start, end } = dateRange(args);
        return get(`/v1/reporting/transactions?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&fields=transaction_info,payer_info&page_size=100`);
      },
    },
    {
      definition: {
        name: "paypal_list_invoices",
        description: "List invoices in this PayPal account, newest first.",
        input_schema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" } } },
      },
      run: async (args) => get(`/v2/invoicing/invoices?page=${clampInt(args.page, 1, 50, 1)}&page_size=${clampInt(args.page_size, 1, 50, 20)}&total_required=true`),
    },
    {
      definition: {
        name: "paypal_get_invoice",
        description: "Get one PayPal invoice by its id (for example INV2-XXXX-XXXX-XXXX-XXXX).",
        input_schema: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] },
      },
      run: async (args) => {
        const id = String(args.invoice_id ?? "");
        if (!/^[A-Z0-9-]{6,40}$/i.test(id)) return JSON.stringify({ error: "invalid invoice id" });
        return get(`/v2/invoicing/invoices/${encodeURIComponent(id)}`);
      },
    },
  ];
}

/** Deterministic stand-ins with the same names, so prompts and tests do not change between modes. */
export function mockPayPalTools(): AgentTool[] {
  return [
    {
      definition: {
        name: "paypal_list_transactions",
        description: "List PayPal transactions for this business in a date range (mock: returns seeded history).",
        input_schema: { type: "object", properties: { start_date: { type: "string" }, end_date: { type: "string" }, search_months: { type: "number" } } },
      },
      run: async () =>
        JSON.stringify({
          transaction_details: [
            { transaction_info: { transaction_id: "7XJ48201MC3184019", transaction_amount: { currency_code: "USD", value: "-180.00" }, transaction_note: "JOB-HG4D-0914 guide fee", transaction_initiation_date: "2026-09-16T03:12:44Z", transaction_status: "S" }, payer_info: { email_address: "maria.santos@example.com" } },
            { transaction_info: { transaction_id: "5RD93117KK9023702", transaction_amount: { currency_code: "USD", value: "-240.00" }, transaction_note: "INV-2026-0138 van rental", transaction_initiation_date: "2026-09-22T09:40:10Z", transaction_status: "S" }, payer_info: { email_address: "phuong.transport@example.com" } },
          ],
          total_items: 2,
        }),
    },
    {
      definition: {
        name: "paypal_list_invoices",
        description: "List invoices in this PayPal account (mock).",
        input_schema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" } } },
      },
      run: async () => JSON.stringify({ items: [], total_items: 0 }),
    },
  ];
}
