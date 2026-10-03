/** Client-credentials token for PayPal REST. Shared by the rail adapter and the agent toolkit. */
export async function fetchPayPalAccessToken(clientId: string, clientSecret: string, env: "sandbox" | "live"): Promise<{ token: string; expiresIn: number }> {
  const baseUrl = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const r = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`PayPal auth failed: HTTP ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  return { token: j.access_token, expiresIn: j.expires_in };
}
