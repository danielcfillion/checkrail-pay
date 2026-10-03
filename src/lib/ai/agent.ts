import Anthropic from "@anthropic-ai/sdk";
import type { AiInterpretation, EvidenceItem, VendorPayoutProfile } from "../domain/types";
import { config, isLiveAi } from "../config";
import { interpretWithRules } from "./extractor";
import { loadPayPalTools, type AgentTool } from "./paypalTools";

export interface AgentInput {
  rawInput: string;
  sourceType: string;
  vendors: VendorPayoutProfile[];
  evidence: EvidenceItem[];
  businessName: string;
  baseCurrency: string;
}

export interface AgentRun {
  interpretation: AiInterpretation;
  engine: "claude" | "rules";
  model: string | null;
  toolCalls: Array<{ name: string; input: unknown; resultPreview: string }>;
}

const SYSTEM = `You are Dueline's obligation agent for an SME finance team. Your job is to read a messy payment request (an invoice, a job-completion note, a booking record, or an operator's chat message) and work out, carefully, who is owed what and whether the evidence supports it.

You do NOT have the authority to pay anyone. A deterministic policy engine decides whether money moves. Your output is advice: a structured interpretation plus plain-language flags. Being conservative is correct: if an amount does not match the evidence, say so; if a reference was already paid, say so; if the request contains urgency pressure or changed bank details, say so.

Rules:
- Use lookup_vendor to resolve names to known vendors. Never invent a vendor.
- Use read_evidence to see every attached record before judging.
- Use paypal_list_transactions to check whether this vendor or reference was already paid through PayPal recently.
- Amounts: integer minor units (cents). Currency: ISO code.
- Confidence: 0 to 100, your honest confidence that the structured fields are correct AND the obligation is legitimate.
- When done, call submit_interpretation exactly once.`;

export async function runObligationAgent(input: AgentInput): Promise<AgentRun> {
  if (!isLiveAi()) {
    return { interpretation: interpretWithRules(input), engine: "rules", model: null, toolCalls: [] };
  }
  try {
    return await runClaude(input);
  } catch (e) {
    console.warn(`[ai] Claude run failed, falling back to rules: ${(e as Error).message}`);
    const interpretation = interpretWithRules(input);
    interpretation.flags.push("Model call failed; interpretation produced by the rule-based fallback");
    return { interpretation, engine: "rules", model: null, toolCalls: [] };
  }
}

async function runClaude(input: AgentInput): Promise<AgentRun> {
  const client = new Anthropic({ apiKey: config.ai.anthropicApiKey });
  const paypalTools = await loadPayPalTools();
  const localTools: AgentTool[] = [
    {
      definition: {
        name: "lookup_vendor",
        description: "Find known vendors by (partial) name. Returns id, name, role, country and which payout methods are on file.",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      run: async (args) => {
        const q = String(args.query ?? "").toLowerCase();
        const hits = input.vendors.filter((v) => v.name.toLowerCase().includes(q) || q.split(/\s+/).some((p) => p.length > 2 && v.name.toLowerCase().includes(p)));
        return JSON.stringify(hits.map((v) => ({ id: v.id, name: v.name, country: v.country, paypal: !!v.paypalEmail, stellar: !!v.stellarAccount, bank: v.bankLabel, verifiedAt: v.verifiedAt })));
      },
    },
    {
      definition: {
        name: "read_evidence",
        description: "Return all evidence records attached to this obligation (contracts, job sheets, bookings, invoices, messages).",
        input_schema: { type: "object", properties: {} },
      },
      run: async () => JSON.stringify(input.evidence),
    },
  ];
  const submitTool: Anthropic.Tool = {
    name: "submit_interpretation",
    description: "Submit the final structured interpretation. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        vendorId: { type: ["string", "null"] },
        vendorName: { type: ["string", "null"] },
        amountMinor: { type: ["integer", "null"] },
        currency: { type: ["string", "null"] },
        description: { type: "string" },
        sourceRef: { type: ["string", "null"] },
        dueDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
        summary: { type: "string", description: "Two sentences for a busy finance manager." },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        flags: { type: "array", items: { type: "string" } },
        missing: { type: "array", items: { type: "string" } },
      },
      required: ["vendorId", "vendorName", "amountMinor", "currency", "description", "sourceRef", "dueDate", "summary", "confidence", "flags", "missing"],
    },
  };
  const tools = [...localTools, ...paypalTools];
  const toolMap = new Map(tools.map((t) => [t.definition.name, t]));
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Business: ${input.businessName} (base currency ${input.baseCurrency}).\nSource type: ${input.sourceType}.\n\nRaw request:\n"""\n${input.rawInput}\n"""\n\nInterpret this obligation. Use the tools, then submit.`,
    },
  ];
  const toolCalls: AgentRun["toolCalls"] = [];

  for (let turn = 0; turn < 8; turn++) {
    const res = await client.messages.create({
      model: config.ai.model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [...tools.map((t) => t.definition), submitTool],
      messages,
    });
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      if (u.name === "submit_interpretation") {
        const i = u.input as AiInterpretation;
        return { interpretation: normalise(i, input), engine: "claude", model: config.ai.model, toolCalls };
      }
      const tool = toolMap.get(u.name);
      const out = tool ? await tool.run(u.input as Record<string, unknown>) : `Unknown tool ${u.name}`;
      toolCalls.push({ name: u.name, input: u.input, resultPreview: out.slice(0, 200) });
      results.push({ type: "tool_result", tool_use_id: u.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Agent did not submit an interpretation");
}

/** Clamp and sanity-check model output; the policy engine trusts nothing it has not seen. */
function normalise(i: AiInterpretation, input: AgentInput): AiInterpretation {
  const vendor = i.vendorId ? input.vendors.find((v) => v.id === i.vendorId) ?? null : null;
  return {
    vendorId: vendor?.id ?? null,
    vendorName: vendor?.name ?? i.vendorName ?? null,
    amountMinor: Number.isInteger(i.amountMinor) && (i.amountMinor as number) > 0 ? i.amountMinor : null,
    currency: typeof i.currency === "string" ? i.currency.toUpperCase().slice(0, 3) : null,
    description: String(i.description ?? "").slice(0, 200),
    sourceRef: i.sourceRef ? String(i.sourceRef).toUpperCase() : null,
    dueDate: i.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(i.dueDate) ? i.dueDate : null,
    summary: String(i.summary ?? "").slice(0, 600),
    confidence: Math.max(0, Math.min(100, Math.round(Number(i.confidence) || 0))),
    flags: Array.isArray(i.flags) ? i.flags.map(String).slice(0, 10) : [],
    missing: Array.isArray(i.missing) ? i.missing.map(String).slice(0, 10) : [],
  };
}
