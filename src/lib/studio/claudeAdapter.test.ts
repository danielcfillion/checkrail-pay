import { describe, it, expect, vi } from "vitest";
import type { AgAiConversationItem, AgAiEvent, AgAiToolSchema, AgLlmRequest } from "ag-studio";
import { claudeAdapter, encodeClaudeRequest, toStrictSchema, type ClaudeReasoningItem, type ClaudeRequestBody } from "./claudeAdapter";

// The network is always mocked: these tests never reach the route or Claude.

const CFG = { maxTokens: 8192, thinking: false };

const tool = (name: string, parameters: unknown, extra: Partial<AgAiToolSchema> = {}): AgAiToolSchema =>
  ({ name, description: `${name} tool`, parameters, ...extra }) as AgAiToolSchema;

const ADD_WIDGET = tool("add_widget", {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["chart", "grid"] },
    title: { anyOf: [{ type: "string" }, { not: {} }] },
  },
  required: ["kind"],
});

const user = (text: string, id = "u1"): AgAiConversationItem => ({ id, kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text }] });

const HISTORY: AgAiConversationItem[] = [
  { id: "s1", kind: "input", type: "message", role: "system", status: "completed", content: [{ type: "text", text: "Today is 31 October." }] },
  user("Why is my calibration score 72?"),
  { id: "a1", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Let me add a chart.", annotations: [] }] },
  { id: "toolu_01", kind: "output", type: "function_call", callId: "toolu_01", name: "add_widget", arguments: '{"kind":"chart","title":"Score"}', status: "completed" },
  { type: "function_call_output", callId: "toolu_01", output: '{"ok":true,"widgetId":"w1"}', status: "completed" },
  { id: "a2", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Added.", annotations: [] }] },
  user("Thanks. And the onboarding figures?", "u2"),
];

const request = (over: Partial<AgLlmRequest> = {}): AgLlmRequest => ({
  input: HISTORY,
  instructions: "You are a Studio assistant.",
  tools: [ADD_WIDGET],
  responseFormat: { type: "text" },
  ...over,
});

/** An SSE body built from Claude events, split into chunks at awkward places to exercise buffering. */
function sse(events: object[], chunkSize = 37): ReadableStream<Uint8Array> {
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

function fakeFetch(body: ReadableStream<Uint8Array> | (() => Response)) {
  const calls: Array<{ url: string; init: RequestInit; body: ClaudeRequestBody }> = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    return typeof body === "function" ? body() : new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function drain(stream: { [Symbol.asyncIterator](): AsyncIterator<AgAiEvent> }): Promise<AgAiEvent[]> {
  const out: AgAiEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const START = { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } } };
const TEXT_AND_TOOL = [
  START,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "ping" },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Onboarding is " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "84% complete." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_02", name: "add_widget", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"kind":"gr' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'id","title":"Onboarding"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

describe("encoding a Studio turn for Claude", () => {
  it("maps instructions, history, tool calls and tool results to Claude messages", () => {
    const { body } = encodeClaudeRequest(request(), CFG);
    expect(body.system).toBe("You are a Studio assistant.\n\nToday is 31 October.");
    expect(body.model).toBeUndefined(); // the server picks its configured model
    expect(body.max_tokens).toBe(8192);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Why is my calibration score 72?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me add a chart." },
          { type: "tool_use", id: "toolu_01", name: "add_widget", input: { kind: "chart", title: "Score" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: '{"ok":true,"widgetId":"w1"}' }] },
      { role: "assistant", content: [{ type: "text", text: "Added." }] },
      { role: "user", content: [{ type: "text", text: "Thanks. And the onboarding figures?" }] },
    ]);
  });

  it("offers exactly the tools Studio passes in, with the Shape 'undefined' branch removed", () => {
    const { body } = encodeClaudeRequest(request({ tools: [ADD_WIDGET, tool("web_search", {}, { kind: "provided", provider: { type: "web_search" } })] }), CFG);
    expect(body.tools).toEqual([
      {
        name: "add_widget",
        description: "add_widget tool",
        input_schema: { type: "object", properties: { kind: { type: "string", enum: ["chart", "grid"] }, title: { type: "string" } }, required: ["kind"] },
      },
    ]);
  });

  it("maps toolChoice to Claude's tool_choice", () => {
    const choice = (toolChoice: AgLlmRequest["toolChoice"]) => encodeClaudeRequest(request({ toolChoice }), CFG).body.tool_choice;
    expect(choice(undefined)).toBeUndefined();
    expect(choice("auto")).toEqual({ type: "auto" });
    expect(choice("none")).toEqual({ type: "none" });
    expect(choice("required")).toEqual({ type: "any" });
    expect(choice({ name: "add_widget" })).toEqual({ type: "tool", name: "add_widget" });
    // No tools, no tool_choice (Claude refuses one without tools).
    expect(encodeClaudeRequest(request({ tools: [], toolChoice: "required" }), CFG).body.tool_choice).toBeUndefined();
  });

  it("fills in a missing tool result and keeps a stray one as text, so Claude accepts the history", () => {
    const { body } = encodeClaudeRequest(
      request({
        input: [
          user("Add two charts."),
          { id: "c1", kind: "output", type: "function_call", callId: "call.1", name: "add_widget", arguments: '{"kind":"chart"}' },
          { id: "c2", kind: "output", type: "function_call", callId: "call.2", name: "add_widget", arguments: "not json" },
          { type: "function_call_output", callId: "call.1", output: "done", status: "completed" },
          { type: "function_call_output", callId: "ghost", output: "orphan", status: "completed" },
          user("Next?", "u3"),
        ],
      }),
      CFG,
    );
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "add_widget", input: { kind: "chart" } },
        { type: "tool_use", id: "call_2", name: "add_widget", input: {} },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "done" },
        { type: "tool_result", tool_use_id: "call_2", content: "No result: this tool call did not complete.", is_error: true },
        { type: "text", text: "Result of an earlier tool call (ghost): orphan" },
        { type: "text", text: "Next?" },
      ],
    });
  });

  it("asks for adaptive thinking when enabled, replays Claude's signed thinking, and drops it when a tool is forced", () => {
    const reasoning: ClaudeReasoningItem = { id: "r1", kind: "output", type: "reasoning", summary: [{ type: "summary", text: "Check" }], claudeBlock: { type: "thinking", thinking: "Check", signature: "sig" } };
    const input: AgAiConversationItem[] = [
      user("Add a chart."),
      reasoning,
      { id: "t1", kind: "output", type: "function_call", callId: "toolu_9", name: "add_widget", arguments: "{}" },
      { type: "function_call_output", callId: "toolu_9", output: "ok", status: "completed" },
    ];
    const on = encodeClaudeRequest(request({ input }), { ...CFG, thinking: true }).body;
    expect(on.thinking).toEqual({ type: "adaptive" });
    expect(on.messages[1].content[0]).toEqual({ type: "thinking", thinking: "Check", signature: "sig" });
    expect(encodeClaudeRequest(request({ input, toolChoice: { name: "add_widget" } }), { ...CFG, thinking: true }).body.thinking).toBeUndefined();
    // Without the signed block (history from elsewhere), thinking is left off rather than failing the turn.
    const unsigned = [input[0], { ...reasoning, claudeBlock: undefined }, input[2], input[3]];
    expect(encodeClaudeRequest(request({ input: unsigned }), { ...CFG, thinking: true }).body.thinking).toBeUndefined();
  });

  it("passes the picked model and a known effort through", () => {
    const { body } = encodeClaudeRequest(request({ model: { id: "claude-sonnet-5-5", effort: "low" } }), CFG);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(encodeClaudeRequest(request({ model: { id: "x", effort: "turbo" } }), CFG).body.output_config).toBeUndefined();
  });

  it("asks for a JSON reply with structured output and an instruction", () => {
    const schema = { type: "object", properties: { score: { type: "integer", minimum: 0, maximum: 100 }, note: { type: "string", maxLength: 80 } }, required: ["score"] };
    const { body } = encodeClaudeRequest(request({ responseFormat: { type: "json", name: "calibration", schema } as AgLlmRequest["responseFormat"] }), CFG);
    expect(body.output_config?.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { score: { type: "integer", description: '{minimum: 0, maximum: 100}' }, note: { type: "string", description: '{maxLength: 80}' } },
        required: ["score"],
        additionalProperties: false,
      },
    });
    expect(body.system).toMatch(/Reply with only a JSON value for "calibration"/);
    expect(() => toStrictSchema({ type: "object", additionalProperties: { type: "number" } })).toThrow(/open-ended/);
  });
});

describe("decoding Claude's stream", () => {
  it("streams text and a tool call with streamed JSON arguments as AG-UI events, then the final response", async () => {
    const { fetch, calls } = fakeFetch(sse(TEXT_AND_TOOL));
    const handler = claudeAdapter({ fetch }).executeTurn(request());
    const events = await drain(handler.stream);
    const res = await handler.complete;

    expect(calls[0].url).toBe("/api/studio-ai");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.stringify(calls[0].init.headers)).not.toMatch(/x-api-key|authorization/i);

    expect(events).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "msg_1_0", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1_0", delta: "Onboarding is " },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1_0", delta: "84% complete." },
      { type: "TEXT_MESSAGE_END", messageId: "msg_1_0" },
      { type: "TOOL_CALL_START", toolCallId: "toolu_02", toolCallName: "add_widget", parentMessageId: "msg_1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "toolu_02", delta: '{"kind":"gr' },
      { type: "TOOL_CALL_ARGS", toolCallId: "toolu_02", delta: 'id","title":"Onboarding"}' },
      { type: "TOOL_CALL_END", toolCallId: "toolu_02" },
    ]);
    expect(res.status).toBe("completed");
    expect(res.id).toBe("msg_1");
    expect(res.model).toBe("claude-sonnet-5-5");
    expect(res.error).toBeUndefined();
    expect(res.output).toEqual([
      { id: "msg_1_0", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Onboarding is 84% complete.", annotations: [] }] },
      { id: "toolu_02", kind: "output", type: "function_call", callId: "toolu_02", name: "add_widget", arguments: '{"kind":"grid","title":"Onboarding"}', status: "completed" },
    ]);
    expect(res.usage).toEqual({ inputTokens: 500, outputTokens: 42, totalTokens: 542, cachedInputTokens: 400 });
  });

  it("reports max_tokens as incomplete, with the truncated message marked", async () => {
    const { fetch } = fakeFetch(
      sse([
        START,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The figures are" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } },
        { type: "message_stop" },
      ]),
    );
    const handler = claudeAdapter({ fetch }).executeTurn(request());
    await drain(handler.stream);
    const res = await handler.complete;
    expect(res.status).toBe("incomplete");
    expect(res.incompleteDetails).toEqual({ reason: "max_output_tokens" });
    expect(res.output[0]).toMatchObject({ type: "message", status: "incomplete" });
  });

  it("maps the other stop reasons", async () => {
    const run = async (stop: string) => {
      const { fetch } = fakeFetch(sse([START, { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } }, { type: "message_stop" }]));
      const h = claudeAdapter({ fetch }).executeTurn(request());
      await drain(h.stream);
      return h.complete;
    };
    expect((await run("end_turn")).status).toBe("completed");
    expect((await run("stop_sequence")).status).toBe("completed");
    expect(await run("refusal")).toMatchObject({ status: "incomplete", incompleteDetails: { reason: "content_filter" } });
  });

  it("carries Claude's thinking as reasoning, with the signature kept for the next turn", async () => {
    const { fetch, calls } = fakeFetch(
      sse([
        START,
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Score is low because" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_3", name: "add_widget", input: {} } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 20 } } },
        { type: "message_stop" },
      ]),
    );
    const handler = claudeAdapter({ fetch, thinking: true }).executeTurn(request());
    const events = await drain(handler.stream);
    const res = await handler.complete;
    expect(calls[0].body.thinking).toEqual({ type: "adaptive" });
    expect(events.slice(0, 3)).toEqual([
      { type: "REASONING_MESSAGE_START", messageId: "msg_1_0", role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "msg_1_0", delta: "Score is low because" },
      { type: "REASONING_MESSAGE_END", messageId: "msg_1_0" },
    ]);
    // A tool call with no arguments still hands Studio a JSON object.
    expect(events).toContainEqual({ type: "TOOL_CALL_ARGS", toolCallId: "toolu_3", delta: "{}" });
    expect(res.output[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary", text: "Score is low because" }], claudeBlock: { type: "thinking", signature: "SIG" } });
    expect(res.usage?.reasoningTokens).toBe(20);

    // Studio appends the output and the tool result to the history; the next turn sends the signed block back first.
    const next = encodeClaudeRequest(request({ input: [user("Add a chart."), ...res.output, { type: "function_call_output", callId: "toolu_3", output: "ok", status: "completed" }] }), { ...CFG, thinking: true }).body;
    expect(next.messages[1].content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(next.thinking).toEqual({ type: "adaptive" });
  });

  it("reports Claude's error event on the final response, not by throwing", async () => {
    const { fetch } = fakeFetch(
      sse([
        START,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
    );
    const handler = claudeAdapter({ fetch }).executeTurn(request());
    const events = await drain(handler.stream);
    const res = await handler.complete;
    expect(events[events.length - 1]).toEqual({ type: "TEXT_MESSAGE_END", messageId: "msg_1_0" });
    expect(res).toMatchObject({ status: "failed", error: { code: "overloaded_error", message: "Overloaded" } });
  });

  it("reports the route's refusal (assistant off, rate limit) as a failed turn", async () => {
    const { fetch } = fakeFetch(() => new Response("The AI assistant is turned off on this server.", { status: 503 }));
    const handler = claudeAdapter({ fetch }).executeTurn(request());
    expect(await drain(handler.stream)).toEqual([]);
    expect(await handler.complete).toMatchObject({ status: "failed", error: { code: "unavailable", message: "The AI assistant is turned off on this server." } });

    const limited = fakeFetch(() => new Response("Slow down", { status: 429 }));
    const h2 = claudeAdapter({ fetch: limited.fetch }).executeTurn(request());
    await drain(h2.stream);
    expect((await h2.complete).error?.code).toBe("rate_limited");
  });

  it("reports a stream that ends early as failed", async () => {
    const { fetch } = fakeFetch(sse([START, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]));
    const handler = claudeAdapter({ fetch }).executeTurn(request());
    await drain(handler.stream);
    expect(await handler.complete).toMatchObject({ status: "failed", error: { code: "stream_ended" } });
  });

  it("validates a JSON reply", async () => {
    const schema = { type: "object", properties: { score: { type: "integer" } }, required: ["score"] };
    const reply = (text: string) => [
      START,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const run = async (text: string) => {
      const { fetch } = fakeFetch(sse(reply(text)));
      const h = claudeAdapter({ fetch }).executeTurn(request({ responseFormat: { type: "json", name: "calibration", schema } as AgLlmRequest["responseFormat"] }));
      await drain(h.stream);
      return h.complete;
    };
    const ok = await run('```json\n{"score": 72}\n```');
    expect(ok.status).toBe("completed");
    expect(ok.output[0]).toMatchObject({ content: [{ type: "text", text: '{"score": 72}' }] });
    expect(await run('{"note":"x"}')).toMatchObject({ status: "failed", error: { code: "invalid_json", message: "Claude's reply is missing score." } });
    expect(await run("Sure! Here it is")).toMatchObject({ status: "failed", error: { code: "invalid_json" } });
  });

  it("fails the turn, without throwing, when a tool schema cannot be sent", async () => {
    const { fetch, calls } = fakeFetch(sse([]));
    const h = claudeAdapter({ fetch }).executeTurn(request({ tools: [tool("bad", { type: "string" })] }));
    expect(await drain(h.stream)).toEqual([]);
    expect(await h.complete).toMatchObject({ status: "failed", error: { code: "invalid_request" } });
    expect(calls).toHaveLength(0);
  });
});

describe("aborting a turn", () => {
  /** A response whose body sends a first text delta and then waits until the request is aborted. */
  function hangingFetch() {
    let seenSignal: AbortSignal | undefined;
    const fn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      const head = new TextEncoder().encode(
        [START, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } }]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join(""),
      );
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(head);
            return;
          }
          return new Promise<void>((_, reject) => {
            const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
            if (seenSignal?.aborted) fail();
            else seenSignal?.addEventListener("abort", fail, { once: true });
          });
        },
      });
      return new Response(body, { status: 200 });
    });
    return { fetch: fn as unknown as typeof fetch, signal: () => seenSignal };
  }

  it("stops the request on options.signal and reports the turn as cancelled", async () => {
    const { fetch, signal } = hangingFetch();
    const ctl = new AbortController();
    const handler = claudeAdapter({ fetch }).executeTurn(request(), { signal: ctl.signal });
    const events: AgAiEvent[] = [];
    for await (const e of handler.stream) {
      events.push(e);
      if (e.type === "TEXT_MESSAGE_CONTENT") ctl.abort();
    }
    const res = await handler.complete;
    expect(signal()?.aborted).toBe(true);
    // The open message is closed so the chat does not show it stuck.
    expect(events[events.length - 1]).toEqual({ type: "TEXT_MESSAGE_END", messageId: "msg_1_0" });
    expect(res).toMatchObject({ status: "cancelled", error: { code: "cancelled" } });
    expect(res.output[0]).toMatchObject({ type: "message", status: "incomplete", content: [{ text: "Working" }] });
  });

  it("settles as cancelled when aborted before the stream is read, without calling the route", async () => {
    const { fetch } = hangingFetch();
    const ctl = new AbortController();
    ctl.abort();
    const handler = claudeAdapter({ fetch }).executeTurn(request(), { signal: ctl.signal });
    expect((await handler.complete).status).toBe("cancelled");
    expect(await drain(handler.stream)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops the request when the consumer stops reading early", async () => {
    const { fetch, signal } = hangingFetch();
    const handler = claudeAdapter({ fetch }).executeTurn(request());
    for await (const e of handler.stream) if (e.type === "TEXT_MESSAGE_CONTENT") break;
    expect((await handler.complete).status).toBe("cancelled");
    expect(signal()?.aborted).toBe(true);
  });
});
