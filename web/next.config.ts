import type { NextConfig } from "next";

const backendUrl = process.env.BACKEND_URL || `http://127.0.0.1:${process.env.BACKEND_PORT || "8000"}`;

const nextConfig: NextConfig = {
  // Pin the workspace root so Next doesn't pick up sibling lockfiles.
  turbopack: { root: __dirname },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/health", destination: `${backendUrl}/health` },
        { source: "/api/:path*", destination: `${backendUrl}/api/:path*` },
        { source: "/static/:path*", destination: `${backendUrl}/static/:path*` },
      ],
    };
  },
};

export default nextConfig;
