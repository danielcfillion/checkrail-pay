/**
 * Claude (Anthropic Messages API) adapter for AG Studio 3.0.0.
 *
 * Modelled on the OpenAI Responses adapter from AG Studio's docs: it encodes AG Studio's turn (AG to Claude),
 * streams the reply over SSE and decodes it (Claude to AG). It runs in the browser and POSTs the encoded Messages
 * request to this app's own route (src/app/api/studio-ai/route.ts), which holds the Anthropic key, checks the
 * request, caps it and calls Claude with the SDK. Nothing secret is sent from or to the browser.
 *
 * Studio runs every tool itself. The adapter only offers Claude the tools Studio passes in, relays the tool calls
 * Claude makes, and sends the tool results back on the next turn. A failed turn is reported through `complete`
 * (status and error), never by throwing from the stream.
 */
import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiInputContent,
  AgAiOutputItem,
  AgAiReasoningItem,
  AgAiToolSchema,
  AgAiUsage,
  AgLlmAdapter,
  AgLlmExecuteTurnOptions,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseError,
  AgLlmResponseHandler,
} from "ag-studio";

// =============================================================================
// Options
// =============================================================================

export interface ClaudeAdapterOptions {
  /** The app's proxy route. Default `/api/studio-ai`. */
  endpoint?: string;
  /**
   * Model to ask for when the chat offers no model picker. Leave unset to let the server use its configured model
   * (ANTHROPIC_MODEL); the server refuses any other.
   */
  model?: string;
  /** Output token budget asked for per turn. Default 8192; the server caps it whatever is asked. */
  maxTokens?: number;
  /** Ask Claude for adaptive thinking, shown as reasoning in the chat. Default off (faster answers). */
  thinking?: boolean;
  /** Transport, for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface ClaudeConfig {
  endpoint: string;
  model?: string;
  maxTokens: number;
  thinking: boolean;
  fetch: typeof fetch;
}

// =============================================================================
// Claude wire types (hand-written, minimal; the SDK stays on the server)
// =============================================================================

type JsonSchema = Record<string, unknown>;

export type ClaudeThinkingBlock = { type: "thinking"; thinking: string; signature: string };
export type ClaudeRedactedThinkingBlock = { type: "redacted_thinking"; data: string };
export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | {
      type: "document";
      title?: string;
      source:
        | { type: "base64"; media_type: "application/pdf"; data: string }
        | { type: "text"; media_type: "text/plain"; data: string }
        | { type: "url"; url: string };
    }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: string; is_error?: boolean }
  | ClaudeThinkingBlock
  | ClaudeRedactedThinkingBlock;

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: ClaudeContentBlock[];
}

export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: JsonSchema;
}

export type ClaudeToolChoice = { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string };

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** The body the adapter POSTs to the route: a Messages API request without `stream`, which the server sets. */
export interface ClaudeRequestBody {
  model?: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  tool_choice?: ClaudeToolChoice;
  thinking?: { type: "adaptive" };
  output_config?: { effort?: ClaudeEffort; format?: { type: "json_schema"; schema: JsonSchema } };
}

/**
 * A reasoning item that carries Claude's own thinking block. Claude requires the signed thinking of the assistant
 * turn that made a tool call to be sent back with the tool results; AG Studio's reasoning item has no field for the
 * signature, so it rides along here. Studio keeps the adapter's output items as they are within a run.
 */
export type ClaudeReasoningItem = AgAiReasoningItem & { claudeBlock?: ClaudeThinkingBlock | ClaudeRedactedThinkingBlock };

// =============================================================================
// JSON Schema handling
// =============================================================================
//
// Tools are sent non-strict: Claude accepts ordinary JSON Schema for a tool's input, and Studio validates the
// arguments itself before running a tool, so the schema is passed through with one clean-up. AG's Shape library
// marks an optional value as `anyOf: [T, { not: {} }]`; the `{ not: {} }` ("undefined") branch is dropped, since
// optionality is already expressed by `required`.
//
// A JSON response format uses Claude's structured output (output_config.format), which accepts a narrower subset:
// objects must close with `additionalProperties: false`, and numeric, string-length and most array constraints are
// not enforced. Those constraints are moved into the description (as the Anthropic SDK's own helper does) and the
// reply is validated after it arrives.

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUndefinedSentinel(s: unknown): boolean {
  return isSchema(s) && Object.keys(s).length === 1 && isSchema(s.not) && Object.keys(s.not).length === 0;
}

/** Keywords whose values are data, not schemas: never rewritten. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "required"]);

function stripSentinels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSentinels);
  if (!isSchema(value)) return value;
  let node: JsonSchema = value;
  if (Array.isArray(node.anyOf)) {
    const kept = (node.anyOf as unknown[]).filter((b) => !isUndefinedSentinel(b));
    if (kept.length === 0) throw new Error("A tool schema reduces to `undefined` only; nothing to express.");
    if (kept.length !== node.anyOf.length) {
      const rest: JsonSchema = { ...node };
      delete rest.anyOf;
      node = kept.length === 1 && isSchema(kept[0]) ? { ...kept[0], ...rest } : { ...rest, anyOf: kept };
    }
  }
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) out[k] = DATA_KEYWORDS.has(k) ? v : stripSentinels(v);
  return out;
}

/** A tool's parameters as a Claude `input_schema`, which must describe an object. */
export function toToolInputSchema(parameters: unknown, toolName: string): JsonSchema {
  const schema = stripSentinels(parameters);
  if (!isSchema(schema)) throw new Error(`Tool "${toolName}" has no parameter schema.`);
  if (schema.type === undefined && isSchema(schema.properties)) return { type: "object", ...schema };
  if (schema.type !== "object") throw new Error(`Tool "${toolName}": Claude needs the parameters to be an object schema.`);
  return schema;
}

const STRICT_STRING_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const STRICT_KEEP = new Set(["type", "description", "title", "enum", "const", "required", "$ref", "default"]);

/** A JSON Schema reduced to what Claude's structured output enforces; anything else is described, not enforced. */
export function toStrictSchema(input: unknown): JsonSchema {
  const walk = (value: unknown): unknown => {
    if (!isSchema(value)) return value;
    const out: JsonSchema = {};
    const described: JsonSchema = {};
    for (const [k, v] of Object.entries(value)) {
      if (STRICT_KEEP.has(k)) out[k] = v;
      else if (k === "$defs" || k === "definitions" || k === "properties") {
        out[k] = isSchema(v) ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, walk(s)])) : v;
      } else if (k === "anyOf" || k === "oneOf") out.anyOf = Array.isArray(v) ? v.map(walk) : v;
      else if (k === "allOf") out.allOf = Array.isArray(v) ? v.map(walk) : v;
      else if (k === "items" && isSchema(v)) out.items = walk(v);
      else if (k === "additionalProperties") {
        if (v !== false) throw new Error("An open-ended object (additionalProperties, e.g. a record) cannot be expressed in Claude's structured output.");
      } else if (k === "format" && typeof v === "string" && STRICT_STRING_FORMATS.has(v)) out.format = v;
      else if (k === "minItems" && (v === 0 || v === 1)) out.minItems = v;
      else described[k] = v;
    }
    if (out.type === "object" || isSchema(out.properties)) {
      out.type ??= "object";
      out.properties ??= {};
      out.additionalProperties = false;
    }
    const extra = Object.entries(described).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    if (extra.length) out.description = `${typeof out.description === "string" ? `${out.description}\n\n` : ""}{${extra.join(", ")}}`;
    return out;
  };
  return walk(stripSentinels(input)) as JsonSchema;
}

/** Best-effort check of a JSON reply against the requested schema's top level: `json` is the bare JSON when it passes. */
function checkJsonReply(text: string, schema: unknown): { message: string; json?: string } {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { message: "Claude's reply was not valid JSON." };
  }
  if (isSchema(schema)) {
    const isObj = isSchema(parsed);
    if (schema.type === "object" && !isObj) return { message: "Claude's reply was not a JSON object." };
    if (schema.type === "array" && !Array.isArray(parsed)) return { message: "Claude's reply was not a JSON array." };
    if (isObj && Array.isArray(schema.required)) {
      const missing = (schema.required as unknown[]).filter((k) => typeof k === "string" && !(k in (parsed as JsonSchema)));
      if (missing.length) return { message: `Claude's reply is missing ${missing.join(", ")}.` };
    }
  }
  return { message: "", json: body };
}

// =============================================================================
// Encoding: AG to Claude
// =============================================================================

/** Claude tool ids must match ^[a-zA-Z0-9_-]+$; ids that came from elsewhere are mapped the same way on both sides. */
function toolId(callId: string): string {
  const id = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return id || "call";
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(args || "{}");
    return isSchema(v) ? v : { value: v };
  } catch {
    return {};
  }
}

function parseDataUrl(url: string): { mediaType: string; base64: boolean; data: string } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return null;
  return { mediaType: (m[1] || "text/plain").toLowerCase(), base64: !!m[3], data: m[4] };
}

function decodeText(data: string, base64: boolean): string {
  if (!base64) return decodeURIComponent(data);
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const note = (text: string): ClaudeContentBlock => ({ type: "text", text });

function encodeInputContent(c: AgAiInputContent): ClaudeContentBlock | null {
  switch (c.type) {
    case "text":
      return c.text ? { type: "text", text: c.text } : null;
    case "image": {
      const d = c.imageUrl ? parseDataUrl(c.imageUrl) : null;
      if (d && d.base64 && IMAGE_TYPES.has(d.mediaType)) return { type: "image", source: { type: "base64", media_type: d.mediaType, data: d.data } };
      if (c.imageUrl && /^https?:\/\//i.test(c.imageUrl)) return { type: "image", source: { type: "url", url: c.imageUrl } };
      return note("[An image was attached in a form this assistant cannot read.]");
    }
    case "file": {
      const title = c.filename || undefined;
      if (c.fileData) {
        const d = parseDataUrl(c.fileData) ?? { mediaType: /\.pdf$/i.test(c.filename ?? "") ? "application/pdf" : "", base64: true, data: c.fileData };
        if (d.mediaType === "application/pdf" && d.base64) return { type: "document", title, source: { type: "base64", media_type: "application/pdf", data: d.data } };
        if (/^text\/|^application\/(json|csv)/.test(d.mediaType)) {
          try {
            return { type: "document", title, source: { type: "text", media_type: "text/plain", data: decodeText(d.data, d.base64) } };
          } catch {
            /* fall through to the note */
          }
        }
      } else if (c.fileUrl && /^https?:\/\//i.test(c.fileUrl)) {
        return { type: "document", title, source: { type: "url", url: c.fileUrl } };
      }
      return note(`[A file${title ? ` (${title})` : ""} was attached in a form this assistant cannot read.]`);
    }
  }
}

/**
 * The conversation as Claude messages. Consecutive items of one role are merged into one message; system input
 * messages are returned separately for the system prompt, since Claude takes no system role in the history.
 */
export function encodeConversation(items: AgAiConversationItem[]): { messages: ClaudeMessage[]; system: string[] } {
  const turns: ClaudeMessage[] = [];
  const system: string[] = [];
  const push = (role: ClaudeMessage["role"], blocks: Array<ClaudeContentBlock | null>) => {
    const content = blocks.filter((b): b is ClaudeContentBlock => b !== null);
    if (!content.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else turns.push({ role, content });
  };

  for (const item of items) {
    if (item.type === "function_call_output") {
      push("user", [{ type: "tool_result", tool_use_id: toolId(item.callId), ...(item.output ? { content: item.output } : {}) }]);
    } else if (item.kind === "input" && item.type === "message") {
      if (item.role === "system") {
        const text = item.content.map((c) => (c.type === "text" ? c.text : "")).filter(Boolean).join("\n");
        if (text) system.push(text);
      } else {
        push("user", item.content.map(encodeInputContent));
      }
    } else if (item.kind === "output" && item.type === "message") {
      push("assistant", item.content.map((c) => {
        const text = c.type === "text" ? c.text : c.refusal;
        return text ? { type: "text", text } : null;
      }));
    } else if (item.kind === "output" && item.type === "function_call") {
      push("assistant", [{ type: "tool_use", id: toolId(item.callId), name: item.name, input: parseArgs(item.arguments) }]);
    } else if (item.kind === "output" && item.type === "reasoning") {
      // Only Claude's own signed thinking can go back; reasoning from anywhere else is dropped (Claude would refuse it).
      const block = (item as ClaudeReasoningItem).claudeBlock;
      if (block) push("assistant", [block]);
    } else {
      throw new Error(`Unknown conversation item type: ${(item as { type: string }).type}`);
    }
  }
  return { messages: repairToolPairs(turns), system };
}

/**
 * Claude refuses a tool call without a result in the very next message, and a result without its call. A history
 * can hold either (a cancelled run, a call Studio did not answer), so a missing result is filled in as an error and
 * a stray result is kept as plain text.
 */
function repairToolPairs(turns: ClaudeMessage[]): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];
  if (turns[0]?.role === "assistant") out.push({ role: "user", content: [note("(Continuing the conversation.)")] });
  for (let i = 0; i < turns.length; i++) {
    const msg = turns[i];
    if (msg.role === "assistant") {
      out.push(msg);
      const offered = msg.content.some((b) => b.type === "tool_use");
      if (offered && turns[i + 1]?.role !== "user") turns.splice(i + 1, 0, { role: "user", content: [] });
      continue;
    }
    const prev = out[out.length - 1];
    const offered = prev?.role === "assistant" ? prev.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])) : [];
    const answered = new Set<string>();
    const results: ClaudeContentBlock[] = [];
    const rest: ClaudeContentBlock[] = [];
    for (const b of msg.content) {
      if (b.type !== "tool_result") rest.push(b);
      else if (offered.includes(b.tool_use_id) && !answered.has(b.tool_use_id)) {
        answered.add(b.tool_use_id);
        results.push(b);
      } else if (!answered.has(b.tool_use_id)) {
        rest.push(note(`Result of an earlier tool call (${b.tool_use_id}): ${b.content ?? ""}`));
      }
    }
    for (const id of offered) {
      if (!answered.has(id)) results.push({ type: "tool_result", tool_use_id: id, content: "No result: this tool call did not complete.", is_error: true });
    }
    // Tool results must come first in the message that answers the calls.
    const content = [...results, ...rest];
    if (content.length) out.push({ role: "user", content });
  }
  return out;
}

function encodeToolChoice(choice: AgLlmRequest["toolChoice"]): ClaudeToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

/**
 * Only tools Studio executes are offered. A `provided` tool is a provider-hosted tool in the provider's own form;
 * Claude's hosted tools (web search, code execution and so on) are refused by the route on purpose.
 */
function encodeTools(tools: AgAiToolSchema[]): ClaudeTool[] {
  return tools
    .filter((t) => t.kind !== "provided")
    .map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: toToolInputSchema(t.parameters, t.name) }));
}

/**
 * Claude refuses thinking when the turn that made the pending tool calls has no thinking block to send back, and
 * when a tool is forced. Thinking is left off for such a turn rather than failing it.
 */
function thinkingAllowed(messages: ClaudeMessage[], choice: ClaudeToolChoice | undefined): boolean {
  if (choice?.type === "any" || choice?.type === "tool") return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (!m.content.some((b) => b.type === "tool_use")) return true;
    const first = m.content[0]?.type;
    return first === "thinking" || first === "redacted_thinking";
  }
  return true;
}

/** The Messages request for one AG Studio turn, and the JSON schema to check the reply against, if any. */
export function encodeClaudeRequest(request: AgLlmRequest, cfg: Pick<ClaudeConfig, "model" | "maxTokens" | "thinking">): { body: ClaudeRequestBody; jsonSchema?: unknown } {
  const { messages, system: systemMessages } = encodeConversation(request.input);
  if (!messages.length) throw new Error("There is nothing to send: the conversation is empty.");
  const system = [request.instructions ?? "", ...systemMessages].filter((s) => s.trim());
  const body: ClaudeRequestBody = { max_tokens: cfg.maxTokens, messages };

  // `request.model` is whichever model the reader picked, absent when the chat offers no choice.
  const model = request.model?.id ?? cfg.model;
  if (model) body.model = model;

  const tools = encodeTools(request.tools ?? []);
  if (tools.length) {
    body.tools = tools;
    const choice = encodeToolChoice(request.toolChoice);
    if (choice) body.tool_choice = choice;
  }

  let jsonSchema: unknown;
  const format = request.responseFormat;
  if (format?.type === "json") {
    jsonSchema = format.schema;
    body.output_config = { format: { type: "json_schema", schema: toStrictSchema(format.schema) } };
    system.push(
      `Reply with only a JSON value for "${format.name}"${format.description ? ` (${format.description})` : ""}, matching this JSON Schema. No prose and no code fences.\n${JSON.stringify(format.schema)}`,
    );
  }

  // Studio's effort ids pass straight through when they are ones Claude knows; others are ignored.
  const effort = request.model?.effort;
  if (effort && (CLAUDE_EFFORTS as readonly string[]).includes(effort)) body.output_config = { ...body.output_config, effort: effort as ClaudeEffort };

  if (cfg.thinking && thinkingAllowed(messages, body.tool_choice)) body.thinking = { type: "adaptive" };
  if (system.length) body.system = system.join("\n\n");
  return { body, jsonSchema };
}

// =============================================================================
// Decoding: Claude to AG
// =============================================================================

interface ClaudeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
}

/** One SSE payload of the Messages stream (only the fields read here). */
interface ClaudeStreamEvent {
  type: string;
  index?: number;
  message?: { id?: string; model?: string; usage?: ClaudeUsage };
  content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; data?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null };
  usage?: ClaudeUsage;
  error?: { type?: string; message?: string };
}

interface Block {
  kind: "text" | "thinking" | "redacted" | "tool";
  /** AG id: the message id for text and reasoning, the tool call id for a tool call. */
  id: string;
  /** Text, thinking text, or the tool call's JSON arguments so far. */
  text: string;
  name?: string;
  signature?: string;
  data?: string;
  done: boolean;
  /** Closed because the stream stopped, not by Claude. */
  cut?: boolean;
}

export interface TurnEnding {
  createdAt: number;
  /** Set when the transport or the route failed before or during the stream. */
  failure?: AgLlmResponseError;
  /** Set when the turn was aborted. */
  cancelled?: boolean;
  /** The schema a JSON reply must match. */
  jsonSchema?: unknown;
}

/**
 * Translates Claude's Messages stream into AG Studio's events, and assembles the final response.
 *
 * Claude's stream is block-and-index shaped (one message, numbered content blocks); AG Studio is message-shaped,
 * keyed by id. Each text block becomes its own AG message, each thinking block a reasoning item, and each tool_use
 * block a tool call keyed by Claude's tool_use id.
 */
export class ClaudeStreamTranslator {
  private messageId = "";
  private model?: string;
  private readonly blocks = new Map<number, Block>();
  private stopReason: string | null = null;
  private stopped = false;
  private error?: AgLlmResponseError;
  private readonly usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: undefined as number | undefined, seen: false };

  translate(ev: ClaudeStreamEvent): AgAiEvent[] {
    switch (ev.type) {
      case "message_start":
        this.messageId = ev.message?.id || `msg_${Date.now().toString(36)}`;
        this.model = ev.message?.model;
        this.addUsage(ev.message?.usage);
        return [];
      case "content_block_start":
        return this.open(ev.index ?? this.blocks.size, ev.content_block);
      case "content_block_delta":
        return this.delta(ev.index ?? -1, ev.delta);
      case "content_block_stop":
        return this.close(ev.index ?? -1);
      case "message_delta":
        if (ev.delta?.stop_reason !== undefined) this.stopReason = ev.delta.stop_reason;
        this.addUsage(ev.usage);
        return [];
      case "message_stop":
        this.stopped = true;
        return [];
      case "ping":
        return [];
      case "error":
        this.error ??= { code: ev.error?.type || "api_error", message: ev.error?.message || "Claude returned an error." };
        return [];
      default:
        return [{ type: "RAW", event: ev, source: "anthropic" }];
    }
  }

  /** End events for blocks still open, so the chat never shows a message stuck mid-stream after an abort or error. */
  closeOpen(): AgAiEvent[] {
    const events: AgAiEvent[] = [];
    for (const [index, b] of this.blocks) if (!b.done) events.push(...this.close(index, false));
    return events;
  }

  private addUsage(u: ClaudeUsage | undefined) {
    if (!u) return;
    this.usage.seen = true;
    // Claude reports cumulative counts; a null means "unchanged".
    if (typeof u.input_tokens === "number") this.usage.input = u.input_tokens;
    if (typeof u.output_tokens === "number") this.usage.output = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === "number") this.usage.cacheWrite = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.usage.cacheRead = u.cache_read_input_tokens;
    if (typeof u.output_tokens_details?.thinking_tokens === "number") this.usage.thinking = u.output_tokens_details.thinking_tokens;
  }

  private open(index: number, cb: ClaudeStreamEvent["content_block"]): AgAiEvent[] {
    const id = `${this.messageId || "msg"}_${index}`;
    switch (cb?.type) {
      case "text": {
        this.blocks.set(index, { kind: "text", id, text: cb.text ?? "", done: false });
        const events: AgAiEvent[] = [{ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }];
        if (cb.text) events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: cb.text });
        return events;
      }
      case "thinking": {
        this.blocks.set(index, { kind: "thinking", id, text: cb.thinking ?? "", signature: cb.signature || undefined, done: false });
        const events: AgAiEvent[] = [{ type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" }];
        if (cb.thinking) events.push({ type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: cb.thinking });
        return events;
      }
      case "redacted_thinking":
        // Encrypted: nothing to show, but it must go back to Claude with the tool results.
        this.blocks.set(index, { kind: "redacted", id, text: "", data: cb.data ?? "", done: true });
        return [];
      case "tool_use": {
        const callId = cb.id || `toolu_${index}`;
        this.blocks.set(index, { kind: "tool", id: callId, name: cb.name ?? "", text: "", done: false });
        return [{ type: "TOOL_CALL_START", toolCallId: callId, toolCallName: cb.name ?? "", ...(this.messageId ? { parentMessageId: this.messageId } : {}) }];
      }
      default:
        return [{ type: "RAW", event: { type: "content_block_start", index, content_block: cb }, source: "anthropic" }];
    }
  }

  private delta(index: number, d: ClaudeStreamEvent["delta"]): AgAiEvent[] {
    const b = this.blocks.get(index);
    if (!b || !d) return [];
    switch (d.type) {
      case "text_delta":
        if (!d.text) return [];
        b.text += d.text;
        return [{ type: "TEXT_MESSAGE_CONTENT", messageId: b.id, delta: d.text }];
      case "thinking_delta":
        if (!d.thinking) return [];
        b.text += d.thinking;
        return [{ type: "REASONING_MESSAGE_CONTENT", messageId: b.id, delta: d.thinking }];
      case "signature_delta":
        b.signature = (b.signature ?? "") + (d.signature ?? "");
        return [];
      case "input_json_delta":
        if (!d.partial_json) return [];
        b.text += d.partial_json;
        return [{ type: "TOOL_CALL_ARGS", toolCallId: b.id, delta: d.partial_json }];
      case "citations_delta":
        return [];
      default:
        return [{ type: "RAW", event: { type: "content_block_delta", index, delta: d }, source: "anthropic" }];
    }
  }

  /** Closes a block: `finished` when Claude ended it, false when the stream was cut off first. */
  private close(index: number, finished = true): AgAiEvent[] {
    const b = this.blocks.get(index);
    if (!b || b.done) return [];
    b.done = true;
    b.cut = !finished;
    switch (b.kind) {
      case "text":
        return [{ type: "TEXT_MESSAGE_END", messageId: b.id }];
      case "thinking":
        return [{ type: "REASONING_MESSAGE_END", messageId: b.id }];
      case "tool": {
        const events: AgAiEvent[] = [];
        // A call with no arguments streams none; Studio still needs a JSON object.
        if (!b.text && finished) {
          b.text = "{}";
          events.push({ type: "TOOL_CALL_ARGS", toolCallId: b.id, delta: "{}" });
        }
        events.push({ type: "TOOL_CALL_END", toolCallId: b.id });
        return events;
      }
      default:
        return [];
    }
  }

  /** The final response. Failures and truncation are reported here, never by throwing. */
  result(end: TurnEnding): AgLlmResponse {
    let status: AgLlmResponse["status"];
    let error: AgLlmResponseError | undefined;
    let incompleteDetails: AgLlmResponse["incompleteDetails"];

    if (end.failure || this.error) {
      status = "failed";
      error = end.failure ?? this.error;
    } else if (this.stopped || this.stopReason) {
      switch (this.stopReason) {
        case "max_tokens":
          status = "incomplete";
          incompleteDetails = { reason: "max_output_tokens" };
          break;
        case "refusal":
          status = "incomplete";
          incompleteDetails = { reason: "content_filter" };
          break;
        case "model_context_window_exceeded":
        case "pause_turn":
          status = "incomplete";
          incompleteDetails = {};
          break;
        default:
          status = "completed";
      }
    } else if (end.cancelled) {
      status = "cancelled";
      error = { code: "cancelled", message: "The turn was cancelled." };
    } else {
      status = "failed";
      error = { code: "stream_ended", message: "The connection closed before Claude finished answering." };
    }

    const output: AgAiOutputItem[] = [];
    const ordered = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    const truncated = status !== "completed";
    for (const b of ordered) {
      if (b.kind === "text") {
        if (!b.text) continue;
        output.push({ id: b.id, kind: "output", type: "message", role: "assistant", status: truncated && b === ordered[ordered.length - 1] ? "incomplete" : "completed", content: [{ type: "text", text: b.text, annotations: [] }] });
      } else if (b.kind === "thinking") {
        const item: ClaudeReasoningItem = { id: b.id, kind: "output", type: "reasoning", summary: b.text ? [{ type: "summary", text: b.text }] : [] };
        if (b.signature) item.claudeBlock = { type: "thinking", thinking: b.text, signature: b.signature };
        output.push(item);
      } else if (b.kind === "redacted") {
        const item: ClaudeReasoningItem = { id: b.id, kind: "output", type: "reasoning", summary: [], claudeBlock: { type: "redacted_thinking", data: b.data ?? "" } };
        output.push(item);
      } else {
        const args = b.text || "{}";
        let complete = b.done && !b.cut;
        try {
          JSON.parse(args);
        } catch {
          complete = false;
        }
        output.push({ id: b.id, kind: "output", type: "function_call", callId: b.id, name: b.name ?? "", arguments: args, status: complete ? "completed" : "incomplete" });
      }
    }

    if (status === "completed" && end.jsonSchema !== undefined) {
      const text = output.flatMap((o) => (o.type === "message" ? o.content.map((c) => (c.type === "text" ? c.text : "")) : [])).join("");
      const check = checkJsonReply(text, end.jsonSchema);
      if (check.json === undefined) {
        status = "failed";
        error = { code: "invalid_json", message: check.message };
      } else {
        // Hand back the bare JSON, without any code fence around it.
        const messages = output.filter((o) => o.type === "message");
        if (messages.length) {
          const first = messages[0];
          if (first.type === "message") first.content = [{ type: "text", text: check.json, annotations: [] }];
          for (const m of messages.slice(1)) output.splice(output.indexOf(m), 1);
        }
      }
    }

    const response: AgLlmResponse = { id: this.messageId || `claude_${end.createdAt.toString(36)}`, createdAt: end.createdAt, status, output };
    if (error) response.error = error;
    if (incompleteDetails) response.incompleteDetails = incompleteDetails;
    if (this.model) response.model = this.model;
    if (this.usage.seen) {
      const u = this.usage;
      const usage: AgAiUsage = { inputTokens: u.input + u.cacheWrite + u.cacheRead, outputTokens: u.output };
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
      if (u.thinking !== undefined) usage.reasoningTokens = u.thinking;
      if (u.cacheRead) usage.cachedInputTokens = u.cacheRead;
      if (u.cacheWrite) usage.cacheWriteTokens = u.cacheWrite;
      response.usage = usage;
    }
    return response;
  }
}

// =============================================================================
// Transport
// =============================================================================

/** The `data:` payloads of an SSE body, one per event. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const payloadOf = (frame: string): string | null => {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(l.startsWith("data: ") ? 6 : 5));
    return data.length ? data.join("\n") : null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const p = payloadOf(frame);
        if (p !== null) yield p;
      }
    }
    const tail = payloadOf((buffer + decoder.decode()).replace(/\r\n?/g, "\n"));
    if (tail !== null) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function httpFailure(res: Response): Promise<AgLlmResponseError> {
  let message = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      message = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? "";
    } catch {
      message = text;
    }
  } catch {
    /* no body */
  }
  const code = res.status === 503 ? "unavailable" : res.status === 429 ? "rate_limited" : res.status === 413 ? "too_large" : `http_${res.status}`;
  return { code, message: message.trim().slice(0, 500) || `HTTP ${res.status}` };
}

function runTurn(cfg: ClaudeConfig, request: AgLlmRequest, signal?: AbortSignal): AgLlmResponseHandler {
  const createdAt = Date.now();
  const translator = new ClaudeStreamTranslator();
  // Our own controller, so a consumer that stops reading early also stops the request.
  const controller = new AbortController();
  const ending: TurnEnding = { createdAt };
  let started = false;
  let settled = false;
  let settle!: (r: AgLlmResponse) => void;
  const complete = new Promise<AgLlmResponse>((resolve) => {
    settle = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    settle(translator.result(ending));
  };
  function onAbort() {
    controller.abort();
    ending.cancelled = true;
    // Nobody is reading the stream yet: settle now, so `complete` never hangs.
    if (!started) finish();
  }
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  /** Runs the request and yields AG events. Never throws: a failure is recorded on `ending`. */
  async function* pump(): AsyncGenerator<AgAiEvent> {
    try {
      const { body, jsonSchema } = encodeClaudeRequest(request, cfg);
      ending.jsonSchema = jsonSchema;
      if (controller.signal.aborted) return;
      const res = await cfg.fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!res.ok) {
        ending.failure = await httpFailure(res);
        return;
      }
      if (!res.body) {
        ending.failure = { code: "empty_response", message: "The assistant's server sent no response stream." };
        return;
      }
      for await (const payload of readSse(res.body)) {
        if (payload === "[DONE]") continue;
        let ev: unknown;
        try {
          ev = JSON.parse(payload);
        } catch {
          ending.failure ??= { code: "bad_stream", message: "Could not read Claude's response stream." };
          return;
        }
        if (isSchema(ev) && typeof ev.type === "string") yield* translator.translate(ev as unknown as ClaudeStreamEvent);
      }
    } catch (e) {
      if (controller.signal.aborted) ending.cancelled = true;
      else ending.failure ??= { code: e instanceof TypeError ? "network_error" : "invalid_request", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async function* events(): AsyncGenerator<AgAiEvent> {
    started = true;
    let ended = false;
    try {
      if (!settled) {
        yield* pump();
        yield* translator.closeOpen();
      }
      ended = true;
    } finally {
      if (!ended) {
        // The consumer stopped reading: stop the request and report the turn as cancelled.
        ending.cancelled = true;
        controller.abort();
      }
      finish();
    }
  }

  const iterator = events();
  return { stream: { [Symbol.asyncIterator]: () => iterator }, complete };
}

// =============================================================================
// Factory
// =============================================================================

/**
 * An AG Studio LLM adapter that talks to Claude through this app's `/api/studio-ai` route.
 *
 *   createAiHarness(api, { adapter: claudeAdapter(), promptStarters })
 */
export function claudeAdapter(options: ClaudeAdapterOptions = {}): AgLlmAdapter {
  const cfg: ClaudeConfig = {
    endpoint: options.endpoint ?? "/api/studio-ai",
    model: options.model,
    maxTokens: options.maxTokens ?? 8192,
    thinking: options.thinking ?? false,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  };
  return {
    executeTurn: (request: AgLlmRequest, opts?: AgLlmExecuteTurnOptions) => runTurn(cfg, request, opts?.signal),
  };
}
