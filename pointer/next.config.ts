import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@chargebee/better-auth"],
  allowedDevOrigins: ["checksum-nextjs.tuns.sh"],
};

export default nextConfig;
