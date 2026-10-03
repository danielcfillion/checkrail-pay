import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { ToastProvider } from "@/components/Toast";
import { getBusiness, getSystemModes } from "@/lib/queries";

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
  title: { default: "Dueline", template: "%s, Dueline" },
  description: "Verified supplier payments, routed and reconciled automatically.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let businessName: string | null = null;
  let system = null;
  try {
    businessName = getBusiness()?.name ?? null;
    system = getSystemModes();
  } catch {
    // Database unavailable: render the shell without a business.
  }
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <ToastProvider>
          <Shell businessName={businessName} system={system}>
            {children}
          </Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
