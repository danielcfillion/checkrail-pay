import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The SDK is mocked: these tests never call Anthropic.
const sdk = vi.hoisted(() => ({ create: vi.fn(), options: [] as unknown[] }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: sdk.create };
    constructor(opts: unknown) {
      sdk.options.push(opts);
    }
  },
}));

import { POST, GET } from "./route";
import { BODY_LIMIT, MAX_OUTPUT_TOKENS, TURN_LIMIT } from "@/lib/studio/studioRequest";
import { config } from "@/lib/config";
import { ACTOR_HEADER } from "@/lib/basicAuth";

const ai = config.ai as { mode: string; anthropicApiKey: string; model: string; studioModel: string; studioAssistant: boolean };
const saved = { ...ai };
const KEY = "sk-ant-test-key-never-sent";
const URL_ = "http://checkrail.test/api/studio-ai";

const BODY = {
  model: "claude-haiku-5-5",
  max_tokens: 64_000,
  system: "You are a Studio assistant.",
  messages: [{ role: "user", content: [{ type: "text", text: "Explain my calibration figures.", cache_control: { type: "ephemeral" } }] }],
  tools: [{ name: "add_widget", description: "Add a widget", input_schema: { type: "object", properties: {} } }],
  tool_choice: { type: "auto" },
  mcp_servers: [{ type: "url", url: "https://evil.example/mcp", name: "x" }],
  container: "c1",
};

let n = 0;
/** A fresh login per test, so the per-login turn limit of one test does not leak into another. */
const login = () => `tester${++n}`;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(URL_, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", [ACTOR_HEADER]: login(), ...headers } }));

/** What the SDK's streaming create resolves to: an async iterable of Claude events with a controller. */
function fakeStream(events: object[], failAfter?: Error) {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      if (failAfter) throw failAfter;
    },
  };
}

const EVENTS = [
  { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];

beforeEach(() => {
  ai.mode = "live";
  ai.anthropicApiKey = KEY;
  ai.model = "claude-sonnet-5-5";
  ai.studioModel = "claude-haiku-5-5";
  sdk.create.mockReset();
  sdk.options.length = 0;
  sdk.create.mockImplementation(async () => fakeStream(EVENTS));
});
afterEach(() => Object.assign(ai, saved));

describe("POST /api/studio-ai", () => {
  it("answers 503 with a plain message when AI_MODE is not live, or there is no key", async () => {
    ai.mode = "mock";
    const off = await post(BODY);
    expect(off.status).toBe(503);
    expect(off.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await off.text()).toMatch(/turned off/);
    ai.mode = "live";
    ai.anthropicApiKey = "";
    expect((await post(BODY)).status).toBe(503);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("runs with AI_MODE mock when STUDIO_ASSISTANT is on and a key is set, and not without the key", async () => {
    ai.mode = "mock";
    ai.studioAssistant = true;
    expect((await post(BODY)).status).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    ai.anthropicApiKey = "";
    expect((await post(BODY)).status).toBe(503);
    ai.anthropicApiKey = KEY;
    ai.studioAssistant = false;
    expect((await post(BODY)).status).toBe(503);
  });

  it("says no to GET", async () => {
    const r = GET();
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });

  it("refuses an oversized body by its declared length, and stops reading a streamed one", async () => {
    const declared = await post("{}", { "content-length": String(BODY_LIMIT + 1) });
    expect(declared.status).toBe(413);

    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 100) return c.close();
        c.enqueue(chunk);
      },
    });
    const streamed = await POST(new Request(URL_, { method: "POST", body, headers: { "content-type": "application/json", [ACTOR_HEADER]: login() }, duplex: "half" } as RequestInit));
    expect(streamed.status).toBe(413);
    // Stopped soon after passing 256 KB, not after reading all 6.4 MB.
    expect(pulled).toBeLessThan(10);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("allows 20 turns per 10 minutes per login", async () => {
    const who = { [ACTOR_HEADER]: "busy-user" };
    for (let i = 0; i < TURN_LIMIT; i++) expect((await post(BODY, who)).status).toBe(200);
    const limited = await post(BODY, who);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(sdk.create).toHaveBeenCalledTimes(TURN_LIMIT);
    // Another login is not affected.
    expect((await post(BODY, { [ACTOR_HEADER]: "other-user" })).status).toBe(200);
  });

  it("sends Claude a rebuilt request: configured model, capped tokens, client tools only, server-side key", async () => {
    const r = await post(BODY);
    expect(r.status).toBe(200);
    expect(sdk.options[0]).toMatchObject({ apiKey: KEY });
    const [params, opts] = sdk.create.mock.calls[0] as [Record<string, unknown>, { signal?: AbortSignal }];
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(params.stream).toBe(true);
    expect(params.tools).toEqual([{ name: "add_widget", description: "Add a widget", input_schema: { type: "object", properties: {} } }]);
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params).not.toHaveProperty("mcp_servers");
    expect(params).not.toHaveProperty("container");
    // The client's cache breakpoints are dropped; the server caches its own system prompt.
    expect(JSON.stringify(params.messages)).not.toMatch(/cache_control/);
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0].text).toMatch(/cannot pay anyone/);
    expect(system[0].text).toMatch(/You are a Studio assistant\./);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect((params.metadata as { user_id: string }).user_id).toMatch(/^[0-9a-f]{32}$/);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("streams Claude's events back as SSE, without the key", async () => {
    const r = await post(BODY);
    expect(r.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const text = await r.text();
    expect(text).toContain('event: message_start\ndata: {"type":"message_start"');
    expect(text).toContain('"text_delta","text":"Hi"');
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain(KEY);
  });

  it("turns a failure mid-stream into Claude's error event", async () => {
    sdk.create.mockImplementation(async () => fakeStream(EVENTS.slice(0, 3), Object.assign(new Error("boom"), { type: "overloaded_error" })));
    const text = await (await post(BODY)).text();
    expect(text).toContain('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"boom"}}');
  });

  it("refuses another model, Claude's hosted tools, and unknown content", async () => {
    expect((await post({ ...BODY, model: "claude-opus-5-5" })).status).toBe(400);
    const hosted = await post({ ...BODY, tools: [...BODY.tools, { type: "web_search_20250305", name: "web_search" }] });
    expect(hosted.status).toBe(400);
    expect(await hosted.text()).toMatch(/only the dashboard's own tools/);
    expect((await post({ ...BODY, messages: [{ role: "user", content: [{ type: "server_tool_use", id: "x", name: "web_search", input: {} }] }] })).status).toBe(400);
    expect((await post({ ...BODY, messages: [{ role: "system", content: "hi" }] })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("refuses another site's page and anything but JSON", async () => {
    expect((await post(BODY, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(BODY, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(BODY, { origin: "http://checkrail.test" })).status).toBe(200);
  });

  it("maps Claude's refusals without leaking details of the key", async () => {
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("401 invalid x-api-key"), { status: 401 }));
    const bad = await post(BODY);
    expect(bad.status).toBe(502);
    expect(await bad.text()).not.toMatch(/x-api-key|sk-ant/);
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("400"), { status: 400, error: { error: { message: "tools.0: bad schema" } } }));
    const r400 = await post(BODY);
    expect(r400.status).toBe(400);
    expect(await r400.text()).toMatch(/tools.0: bad schema/);
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }));
    expect((await post(BODY)).status).toBe(502);
  });
});
