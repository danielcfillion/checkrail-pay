import { desc, eq, gte } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { agentChecks, obligations } from "../db/schema";
import { configuredAgentKeys } from "./keys";

/** What the owner sees about outside agents: who is set up, what they asked, and what Checkrail answered. */

export interface AgentRow {
  name: string;
  scopes: string[];
  configured: boolean;
  lastSeen: string | null;
  checks: number;
  blocked: number;
  held: number;
  cleared: number;
  requests: number;
}

export function agentSummary(db: Db = getDb(), sinceDays = 7): { agents: AgentRow[]; totals: { checks: number; blocked: number; held: number; cleared: number; requests: number }; keysMalformed: boolean } {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const rows = db.select().from(agentChecks).where(gte(agentChecks.createdAt, since)).all();
  const keys = configuredAgentKeys();
  const by = new Map<string, AgentRow>();
  for (const k of keys ?? []) by.set(k.name, { name: k.name, scopes: k.scopes, configured: true, lastSeen: null, checks: 0, blocked: 0, held: 0, cleared: 0, requests: 0 });
  for (const r of rows) {
    const a = by.get(r.agent) ?? { name: r.agent, scopes: [], configured: false, lastSeen: null, checks: 0, blocked: 0, held: 0, cleared: 0, requests: 0 };
    if (r.tool === "request_payment") a.requests++;
    else a.checks++;
    if (r.verdict === "block") a.blocked++;
    else if (r.verdict === "pay") a.cleared++;
    else a.held++;
    if (!a.lastSeen || r.createdAt > a.lastSeen) a.lastSeen = r.createdAt;
    by.set(r.agent, a);
  }
  const agents = [...by.values()].sort((x, y) => (y.lastSeen ?? "").localeCompare(x.lastSeen ?? "") || x.name.localeCompare(y.name));
  const sum = (f: (a: AgentRow) => number) => agents.reduce((s, a) => s + f(a), 0);
  return { agents, totals: { checks: sum((a) => a.checks), blocked: sum((a) => a.blocked), held: sum((a) => a.held), cleared: sum((a) => a.cleared), requests: sum((a) => a.requests) }, keysMalformed: keys === null };
}

export function recentAgentChecks(db: Db = getDb(), limit = 50) {
  return db
    .select({ c: agentChecks, state: obligations.state })
    .from(agentChecks)
    .leftJoin(obligations, eq(obligations.id, agentChecks.obligationId))
    .orderBy(desc(agentChecks.createdAt))
    .limit(limit)
    .all()
    .map(({ c, state }) => ({ ...c, requestState: state ?? null, rules: JSON.parse(c.rulesJson ?? "[]") as string[] }));
}
