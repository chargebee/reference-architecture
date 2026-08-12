import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@chargebee/better-auth"],
  outputFileTracingIncludes: {
    "/*": ["./config/models.yaml"],
  },
  allowedDevOrigins: ["checksum-nextjs.tuns.sh","checksum-nextjs.nue.tuns.sh"],
};

export default nextConfig;
