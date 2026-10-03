import type Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "../config";
import { fetchPayPalAccessToken } from "../rails/paypalAuth";

/**
 * PayPal tools exposed to the obligation agent.
 *
 * Read-only by construction: the agent gets `list_transactions`,
 * `list_invoices`, `get_invoice` and `get_merchant_insights` from the
 * official PayPal Agent Toolkit so it can check PayPal's own records
 * (has this vendor already been paid? does this invoice exist?). It never
 * gets a tool that moves money. Execution is the engine's job, after policy.
 */

export interface AgentTool {
  definition: Anthropic.Tool;
  run(args: Record<string, unknown>): Promise<string>;
}

const READ_ONLY_METHODS = new Set(["list_transactions", "list_invoices", "get_invoice", "get_merchant_insights", "search_invoicing"]);

export async function loadPayPalTools(): Promise<AgentTool[]> {
  const { clientId, clientSecret, env } = config.rails.paypal;
  if (config.rails.mode !== "live" || !clientId || !clientSecret) return mockPayPalTools();

  // Lazy import keeps mock-mode builds light and avoids loading the toolkit without credentials.
  const { PayPalMCPToolkit } = await import("@paypal/agent-toolkit/mcp");
  const { token: accessToken } = await fetchPayPalAccessToken(clientId, clientSecret, env);
  const toolkit = new PayPalMCPToolkit({
    accessToken,
    configuration: {
      actions: {
        transactions: { list: true },
        invoices: { list: true, get: true },
        insights: { get: true },
      },
      context: { sandbox: env !== "live" },
    },
  });
  const api = toolkit.getPaypalAPIService();
  return toolkit
    .getTools()
    .filter((t) => READ_ONLY_METHODS.has(t.method))
    .map((t) => ({
      definition: {
        name: `paypal_${t.method}`,
        description: t.description,
        input_schema: zodToJsonSchema(t.parameters, { target: "openApi3" }) as Anthropic.Tool["input_schema"],
      },
      run: async (args) => api.run(t.method, args),
    }));
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
