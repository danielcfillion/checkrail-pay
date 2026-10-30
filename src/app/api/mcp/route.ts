import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { config } from "@/lib/config";
import { realMoneyEnv } from "@/lib/basicAuth";
import { clientIp, newThrottle, overLimit } from "@/lib/throttle";
import { authenticateAgent, configuredAgentKeys, type AgentKey } from "@/lib/agent/keys";
import { handleMcp, SUPPORTED_VERSIONS } from "@/lib/agent/mcp";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Checkrail's MCP server over HTTP (streamable HTTP, stateless, JSON responses; no server-sent stream).
 *
 * An agent authenticates with an agent key from CHECKRAIL_AGENT_KEYS as a bearer token. The middleware lets this one
 * path through without a login and the key is checked here. On the simulated-rails judging demo only,
 * CHECKRAIL_AGENT_DEMO_OPEN=1 admits callers without a key as the agent "demo-visitor", so a judge can add the URL to
 * an agent and try it; it is ignored whenever rails are live or real money can move.
 */

const BODY_LIMIT = 64 * 1024;
const PER_AGENT_LIMIT = 60; // calls a minute
const BAD_KEY_LIMIT = 20; // wrong keys per address per 15 minutes
const perAgent = newThrottle();
const badKeys = newThrottle();

const open = () => process.env.CHECKRAIL_AGENT_DEMO_OPEN === "1" && config.rails.mode === "mock" && !realMoneyEnv(process.env);
const deny = (status: number, message: string, headers: Record<string, string> = {}) => NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, { status, headers });

export async function POST(req: Request) {
  const keys = configuredAgentKeys();
  if (keys === null) return deny(503, "CHECKRAIL_AGENT_KEYS is malformed (name:secret:check or name:secret:check+request, comma separated); refusing agent calls");
  // A browser page on another site must not drive this endpoint with a visitor's network position.
  const origin = req.headers.get("origin");
  if (origin) {
    let same = false;
    try {
      same = new URL(origin).host === new URL(req.url).host;
    } catch {
      same = false;
    }
    if (!same) return deny(403, "Cross-origin calls are not accepted");
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return deny(415, "Send application/json");

  const ip = clientIp(req.headers, process.env.CHECKRAIL_CLIENT_IP_HEADER);
  if (overLimit(badKeys, ip, BAD_KEY_LIMIT, 15 * 60_000, Date.now(), false)) return deny(429, "Too many wrong keys from this address; wait 15 minutes", { "Retry-After": "900" });
  const header = req.headers.get("authorization");
  let agent: AgentKey | null = authenticateAgent(header, keys);
  if (!agent && header) {
    overLimit(badKeys, ip, BAD_KEY_LIMIT, 15 * 60_000);
    return deny(401, "Unknown agent key", { "WWW-Authenticate": 'Bearer realm="Checkrail Pay agents"' });
  }
  if (!agent && open()) agent = { name: "demo-visitor", scopes: ["check", "request"], digest: Buffer.alloc(32) };
  if (!agent) return deny(401, "An agent key is required (Authorization: Bearer <key>)", { "WWW-Authenticate": 'Bearer realm="Checkrail Pay agents"' });
  // Open demo callers share one name, so they are limited per address as well.
  if (overLimit(perAgent, agent.name === "demo-visitor" ? `demo:${ip}` : agent.name, PER_AGENT_LIMIT, 60_000)) return deny(429, "Slow down: at most 60 calls a minute per agent", { "Retry-After": "60" });

  const raw = await req.text();
  if (raw.length > BODY_LIMIT) return deny(413, "Request too large");
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const asked = req.headers.get("mcp-protocol-version");
  const version = asked && (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : SUPPORTED_VERSIONS[0];
  const reply = await handleMcp(message, { db: getDb(), agent, version: (pkg as { version: string }).version });
  if (!reply) return new Response(null, { status: 202 });
  return NextResponse.json(reply, { headers: { "MCP-Protocol-Version": version, "Cache-Control": "no-store" } });
}

export function GET() {
  return new Response("Checkrail's MCP endpoint takes POST requests (JSON-RPC). There is no event stream.", { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
