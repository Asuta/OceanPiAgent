import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@mariozechner/pi-ai"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
