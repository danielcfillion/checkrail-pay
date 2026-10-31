import { getDb } from "@/lib/db";
import { apiKeyUsage } from "@/lib/db/schema";
import { configuredApiKeys } from "@/lib/api/keys";
import { Panel, RelativeTime } from "@/components/ui";

/**
 * The API keys other software uses (CHECKRAIL_API_KEYS), read only: each key's name, scopes and when it was last used.
 * Never a secret. Keys are added and removed in the server's settings, not here.
 */
export function ApiKeysCard({ className = "mt-6" }: { className?: string }) {
  const keys = configuredApiKeys();
  const usage = new Map(getDb().select().from(apiKeyUsage).all().map((u) => [u.keyName, u]));
  return (
    <Panel title="API keys" aside="read only" className={className} padded={false}>
      <div className="px-5 pb-4 pt-2">
        <p className="text-ink-soft">
          Booking systems, ERPs and accounting tools send departures and payment requests to <span className="mono">/api/v1</span> with one of these keys. A key can ask, never approve or send, and never sees payout details. The API is described at{" "}
          <a href="/api/v1/openapi.json" className="underline hover:text-ink">
            /api/v1/openapi.json
          </a>
          .
        </p>
        {keys === null ? (
          <p className="mt-3 rounded border border-blocked bg-blocked-soft px-3 py-2 text-sm text-ink" role="status">
            CHECKRAIL_API_KEYS is set but malformed, so every API call is refused. Each entry is name:secret:scopes, comma separated.
          </p>
        ) : keys.length === 0 ? (
          <p className="mt-3 text-ink-soft">No API keys yet. Add CHECKRAIL_API_KEYS to the server&apos;s settings (name:secret:scopes) and restart.</p>
        ) : null}
      </div>
      {keys && keys.length > 0 ? (
        <>
          <div className="overflow-x-auto border-t hairline">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Scopes</th>
                  <th scope="col" className="r">
                    Last used
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const u = usage.get(k.name);
                  return (
                    <tr key={k.name}>
                      <td className="mono font-medium">{k.name}</td>
                      <td>
                        <span className="flex flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <span key={s} className={`mono inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-xs ${s === "requests:attest" ? "bg-attention-soft text-ink" : "bg-paper text-ink-soft"}`}>
                              {s}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="r">
                        <RelativeTime iso={u?.lastUsedAt ?? null} />
                        {u ? <span className="num block text-xs text-ink-soft">{u.calls.toLocaleString("en-US")} {u.calls === 1 ? "call" : "calls"}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {keys.some((k) => k.scopes.includes("requests:attest")) ? (
            <p className="border-t px-5 py-3 text-xs text-ink-soft hairline">requests:attest makes what that key attaches count as your own records. Give it only to a system of record. Policy, caps and the cancel window still apply.</p>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}
