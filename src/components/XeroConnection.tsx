import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { xeroCardView } from "@/lib/accounting/xeroSettings";
import { Panel, RelativeTime, TonePill } from "./ui";
import { XeroConnectionControls } from "./XeroConnectionControls";

/**
 * The live Xero connection: connect, the organisation, the account mapping, the last push and anything that could
 * not be sent. Reads only what is stored here (never calls Xero to render) and passes the browser nothing secret.
 * The bills file and the settlement CSV on the Accounting page stay as they are, whichever way the books are fed.
 */
export async function XeroConnection() {
  const biz = getBusiness();
  if (!biz) return null;
  const viewer = await getViewer();
  const v = xeroCardView(getDb(), biz.id);
  const owner = !viewer || viewer.can("settings");
  const mayPush = !viewer || viewer.can("export");

  const status = !v.configured ? (
    <TonePill tone="muted">not set up</TonePill>
  ) : !v.connected ? (
    <TonePill tone="muted">not connected</TonePill>
  ) : v.needsReconnect ? (
    <TonePill tone="attention">connect again</TonePill>
  ) : (
    <TonePill tone="settled">connected</TonePill>
  );

  return (
    <div id="xero" className="mt-6 scroll-mt-16">
      <Panel title="Xero" aside={status}>
        {!v.configured ? (
          <div className="max-w-2xl space-y-2 text-ink-soft">
            <p>Send bills and payments straight to Xero instead of importing files. To turn it on, create an app at developer.xero.com (Web app, Auth Code), then set XERO_CLIENT_ID and XERO_CLIENT_SECRET on the server and restart.</p>
            <p>
              Redirect URI for the Xero app: <span className="mono num break-all text-ink">{v.redirectUri}</span>
            </p>
            <p>The steps are in docs/XERO.md. Until then, the bills file and the settlement CSV on the Accounting page carry the same records.</p>
          </div>
        ) : (
          <>
            {v.connected ? (
              <p className="mb-3">
                <span className="font-medium">{v.tenantName ?? "Your Xero organisation"}</span>
                <span className="text-ink-soft">
                  {" "}
                  connected <RelativeTime iso={v.connectedAt} />. Last push: <RelativeTime iso={v.lastPushAt} />. {v.pushed} sent, {v.failures.length ? `${v.failures.length} could not be sent` : "nothing failed"}.
                </span>
              </p>
            ) : (
              <p className="mb-3 max-w-2xl text-ink-soft">Connect your Xero organisation and Checkrail sends each approved bill to Xero, then its payment and fee when the payment settles. Nothing about a payment waits for Xero.</p>
            )}
            {v.connected && v.destination !== "xero" ? (
              <p className="mb-3 rounded border border-attention bg-attention-soft px-3 py-2 text-sm text-ink" role="status">
                ACCOUNTING_DESTINATION is csv, so nothing is sent yet. Set it to xero on the server and restart.
              </p>
            ) : null}
            {v.blockedUntil ? (
              <p className="mb-3 text-sm text-ink-soft" role="status">
                Xero asked us to slow down. Sending again <RelativeTime iso={v.blockedUntil} />.
              </p>
            ) : null}
            <XeroConnectionControls view={v} owner={owner} mayPush={mayPush} />
          </>
        )}
      </Panel>
    </div>
  );
}
