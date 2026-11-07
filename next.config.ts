import type { NextConfig } from "next";

/**
 * Security headers for every response. The CSP allows inline scripts and styles because Next's App Router inlines
 * its bootstrap; everything else is same-origin only, the app cannot be framed, and forms post only to itself.
 * Uploaded documents are served by /api/attachments with their own stricter, sandboxed policy.
 */
const CSP = [
  "default-src 'self'",
  // Development only: React Refresh evaluates modules with eval, so `npm run dev` needs 'unsafe-eval' to hydrate.
  // Production (`npm run build && npm start`, the hosted demo) never gets it.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const common = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3", "@stellar/stellar-sdk", "@anthropic-ai/sdk", "pdfjs-dist", "exceljs"],
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  async headers() {
    return [
      { source: "/:path*", headers: common },
      { source: "/((?!api/attachments/).*)", headers: [{ key: "Content-Security-Policy", value: CSP }] },
    ];
  },
};

export default nextConfig;
