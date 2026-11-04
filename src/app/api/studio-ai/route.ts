import Anthropic from "@anthropic-ai/sdk";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { config, isStudioAssistantOn } from "@/lib/config";
import { BODY_LIMIT, buildParams, TURN_LIMIT, TURN_WINDOW_MS } from "@/lib/studio/studioRequest";
import { ACTOR_HEADER } from "@/lib/basicAuth";
import { sameOrigin } from "@/lib/auth/session";
import { clientIp, newThrottle, overLimit } from "@/lib/throttle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The server side of the dashboard's AI assistant (AG Studio, with the Claude adapter in src/lib/studio/claudeAdapter.ts).
 *
 * The adapter runs in the browser and POSTs a Claude Messages request here. This route holds the Anthropic key (it is
 * never sent to the browser), rebuilds the request from the fields it accepts, caps the output, allows only the
 * configured model, and streams Claude's reply back as server-sent events in Claude's own event format.
 *
 * The assistant explains onboarding and calibration figures and arranges dashboard widgets with the tools AG Studio
 * gives it, which act only on the dashboard. It must never pay anyone or change payment rules, so the only tools Claude
 * is offered are the client tools in the request: Claude's hosted tools (web search, code execution and the like), MCP
 * servers and containers are refused or dropped here, and no tool is added on the server.
 *
 * The middleware requires a login on this path. Each login may run at most TURN_LIMIT turns per window.
 */

const turns = newThrottle();

const plain = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });

export async function POST(req: Request): Promise<Response> {
  // Off (no key, or neither live AI nor STUDIO_ASSISTANT=1): the dashboard reads the 503 and hides the assistant.
  if (!isStudioAssistantOn()) return plain(503, "The AI assistant is turned off on this server.");

  // A page on another site must not spend this login's turns through the browser's saved credentials.
  const origin = req.headers.get("origin");
  // sameOrigin also matches the forwarded host: behind the host's proxy req.url carries the server's internal address.
  if (origin && !sameOrigin(req.headers, req.url)) return plain(403, "Cross-origin calls are not accepted.");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return plain(415, "Send application/json.");

  // The middleware sets the login; a request without one (none should reach here) is limited by address instead.
  const actor = req.headers.get(ACTOR_HEADER)?.trim();
  const key = actor ? `user:${actor}` : `ip:${clientIp(req.headers, process.env.CHECKRAIL_CLIENT_IP_HEADER)}`;
  const now = Date.now();
  if (overLimit(turns, key, TURN_LIMIT, TURN_WINDOW_MS, now)) {
    const since = turns.get(key)?.since ?? now;
    const wait = Math.max(1, Math.ceil((TURN_WINDOW_MS - (now - since)) / 1000));
    return plain(429, `The assistant allows ${TURN_LIMIT} turns every ${TURN_WINDOW_MS / 60_000} minutes per login. Try again in ${Math.ceil(wait / 60)} minute(s).`, { "Retry-After": String(wait) });
  }

  // Refuse an oversized body by its declared length before reading it, and stop reading one that grows past the limit.
  if (Number(req.headers.get("content-length") ?? 0) > BODY_LIMIT) return plain(413, "The conversation is too long for the assistant. Start a new one.");
  const raw = await readCapped(req, BODY_LIMIT);
  if (raw === null) return plain(413, "The conversation is too long for the assistant. Start a new one.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return plain(400, "The request body must be JSON.");
  }
  const built = buildParams(body, actor ?? key);
  if (typeof built === "string") return plain(400, built);

  const client = new Anthropic({ apiKey: config.ai.anthropicApiKey, maxRetries: 1 });
  let stream: AsyncIterable<RawMessageStreamEvent> & { controller: AbortController };
  try {
    // Stopping the chat aborts the browser's request, which cancels this one too.
    stream = await client.messages.create(built, { signal: req.signal });
  } catch (e) {
    return upstreamError(e);
  }

  const encoder = new TextEncoder();
  const frame = (event: { type: string }) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const events = stream[Symbol.asyncIterator]();
  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await events.next();
        if (done) controller.close();
        else controller.enqueue(frame(value));
      } catch (e) {
        // A failure mid-stream goes to the adapter as Claude's own error event, which it reports on the turn.
        if (!req.signal.aborted) controller.enqueue(frame({ type: "error", error: { type: errorType(e), message: errorMessage(e) } } as { type: string }));
        controller.close();
      }
    },
    cancel() {
      stream.controller.abort();
    },
  });
  return new Response(out, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

export function GET() {
  return plain(405, "The assistant endpoint takes POST requests.", { Allow: "POST" });
}

// =============================================================================
// Helpers
// =============================================================================

/** The body as text, or null as soon as it passes `limit` bytes; the rest is never read. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

function errorType(e: unknown): string {
  const t = (e as { type?: unknown } | null)?.type;
  return typeof t === "string" && t ? t : "api_error";
}

/** Claude's own error message when it sent one, without the SDK's status prefix. Never includes the key. */
function errorMessage(e: unknown): string {
  const body = (e as { error?: { error?: { message?: unknown } } } | null)?.error?.error?.message;
  if (typeof body === "string" && body) return body.slice(0, 500);
  return e instanceof Error ? e.message.slice(0, 500) : "Claude returned an error.";
}

function upstreamError(e: unknown): Response {
  const status = statusOf(e);
  console.warn(`[studio-ai] Claude call failed: ${status ?? "no status"} ${errorType(e)}`);
  if (status === 400 || status === 404 || status === 413 || status === 422) return plain(400, `Claude refused the request: ${errorMessage(e)}`);
  if (status === 429) return plain(429, "Claude's rate limit was reached. Try again in a minute.", { "Retry-After": "60" });
  if (status === 401 || status === 403) return plain(502, "Claude refused the server's API key.");
  // 502, not 503: a 503 from this route means "assistant switched off" to the dashboard.
  return plain(502, "Claude is unavailable or overloaded right now. Try again shortly.");
}
