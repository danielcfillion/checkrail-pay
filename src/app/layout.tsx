import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { ToastProvider } from "@/components/Toast";
import { getBusiness, getSystemModes, waitingFor } from "@/lib/queries";
import { getViewer, isPublicPage } from "@/lib/viewer";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";
import { pendingChanges, verifyBarrier } from "@/lib/engine/vendors";

/*
 * Archivo variable (weight 100 to 900, width 62 to 125), the same file Google
 * Fonts serves. Vendored so the build does not depend on network access; the
 * next/font/google equivalent is:
 *   Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo" })
 */
const archivo = localFont({
  src: [{ path: "./fonts/archivo-variable.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-archivo",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

export const metadata: Metadata = {
  title: { default: "Checkrail Pay", template: "%s, Checkrail Pay" },
  description: "Verified supplier payments, routed and reconciled automatically.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Vendor-facing pages (onboarding, evidence upload) carry a token, not a login: no navigation, no business data.
  if (await isPublicPage()) {
    return (
      <html lang="en" className={archivo.variable}>
        <body>
          <ToastProvider>
            <main className="mx-auto w-full max-w-xl px-4 py-10">{children}</main>
          </ToastProvider>
        </body>
      </html>
    );
  }
  let businessName: string | null = null;
  let system = null;
  let viewer = null;
  let waiting = 0;
  let vendorChecks = 0;
  try {
    businessName = getBusiness()?.name ?? null;
    system = getSystemModes();
    viewer = await getViewer();
    if (viewer) waiting = waitingFor(viewer.actor);
    const bizId = getBusiness()?.id;
    if (viewer && bizId && viewer.can("verify_vendor")) {
      const db = getDb();
      vendorChecks = pendingChanges(db, bizId).filter((c) => !verifyBarrier(db, bizId, viewer!.actor.id, c)).length;
    }
  } catch {
    // Database unavailable: render the shell without a business.
  }
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <ToastProvider>
          <Shell
            businessName={businessName}
            system={system}
            who={viewer ? { name: viewer.actor.displayName, role: ROLE_LABEL[viewer.actor.role], username: viewer.actor.username, viaLogin: viewer.actor.viaLogin, personas: viewer.personas, waiting, vendorChecks } : null}
          >
            {children}
          </Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
