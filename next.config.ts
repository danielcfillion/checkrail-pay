import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@stellar/stellar-sdk", "@paypal/agent-toolkit", "@anthropic-ai/sdk"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};

export default nextConfig;
