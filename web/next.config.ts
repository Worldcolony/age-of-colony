import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next doesn't pick up sibling lockfiles.
  turbopack: { root: __dirname },
};

export default nextConfig;
