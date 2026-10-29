/**
 * Feature flags read on the server. Off unless set to "1".
 *
 * CHECKRAIL_TAX_FEATURES: the Vietnamese PIT and Philippine EWT withholding switches in Settings and the US
 * 1099-NEC panel on Books. Kept off on the hosted demo so a judge sees the payment story, not tax tooling.
 * Withholding rules already saved in a business's policy keep applying either way; the flag only hides the controls.
 */
export function taxFeaturesOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.CHECKRAIL_TAX_FEATURES === "1";
}
