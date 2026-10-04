import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@stellar/stellar-sdk", "@paypal/agent-toolkit", "@anthropic-ai/sdk", "pdfjs-dist"],
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
};

export default nextConfig;
