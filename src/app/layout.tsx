import { runAs } from "@/lib/engine/requestContext";
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
import { listRuns } from "@/lib/engine/runs";

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

const DESCRIPTION = "Checks every supplier payment before money moves.";

/* icon.svg, apple-icon.png and opengraph-image.png in this folder are picked up by Next's file conventions;
   scripts/brand-assets.py generates them. */
export const metadata: Metadata = {
  // Render sets RENDER_EXTERNAL_URL on every service, so the hosted demo's social card resolves without extra setup.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000"),
  title: { default: "Checkrail Pay", template: "%s, Checkrail Pay" },
  description: DESCRIPTION,
  applicationName: "Checkrail Pay",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }], apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }] },
  openGraph: {
    type: "website",
    siteName: "Checkrail Pay",
    title: "Checkrail Pay",
    description: DESCRIPTION,
    // The image itself comes from opengraph-image.png (alt text in opengraph-image.alt.txt).
  },
  twitter: { card: "summary_large_image", title: "Checkrail Pay", description: DESCRIPTION, images: ["/opengraph-image.png"] },
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Vendor-facing pages (onboarding, evidence upload) carry a token, not a login: no navigation, no business data.
  if (await isPublicPage()) {
    return (
      <html lang="en" className={archivo.variable}>
        <body>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <ToastProvider>
            <main id="main" tabIndex={-1} className="print-page mx-auto w-full max-w-xl px-4 py-10 focus:outline-none">{children}</main>
          </ToastProvider>
        </body>
      </html>
    );
  }
  let businessName: string | null = null;
  let system = null;
  let viewer: Awaited<ReturnType<typeof getViewer>> = null;
  let waiting = 0;
  let vendorChecks = 0;
  let runsToRelease = 0;
  try {
    businessName = getBusiness()?.name ?? null;
    system = getSystemModes();
    viewer = await getViewer();
    if (viewer) { const v = viewer; waiting = runAs(v.login, () => waitingFor(v.actor)); }
    const bizId = getBusiness()?.id;
    if (viewer && bizId && viewer.can("verify_vendor")) {
      const db = getDb();
      vendorChecks = runAs(viewer.login, () => pendingChanges(db, bizId).filter((c) => !verifyBarrier(db, bizId, viewer!.actor.id, c)).length);
    }
    if (viewer && bizId && viewer.can("release_run")) runsToRelease = listRuns(getDb(), bizId).filter((r) => r.status === "draft" && r.createdBy !== viewer!.actor.id).length;
  } catch {
    // Database unavailable: render the shell without a business.
  }
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <ToastProvider>
          <Shell
            businessName={businessName}
            system={system}
            who={viewer ? { name: viewer.actor.displayName, role: ROLE_LABEL[viewer.actor.role], username: viewer.actor.username, viaLogin: viewer.actor.viaLogin, personas: viewer.personas, waiting, vendorChecks, runsToRelease } : null}
          >
            {children}
          </Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
