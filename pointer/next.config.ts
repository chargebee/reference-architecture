import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ['checksum-nextjs.tuns.sh']
};

export default nextConfig;
