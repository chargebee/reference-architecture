import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@chargebee/better-auth"],
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  outputFileTracingIncludes: {
    "/*": [
      "./config/models.yaml",
      "./node_modules/@duckdb/node-bindings-*/*.node",
      "./node_modules/@duckdb/node-bindings-*/*.dylib",
      "./node_modules/@duckdb/node-bindings-*/*.so",
    ],
  },
  allowedDevOrigins: ["checksum-nextjs.tuns.sh","checksum-nextjs.nue.tuns.sh"],
  // /dashboard and /flow moved under /admin. Chargebee hosted-page checkouts
  // started before the move still carry a /dashboard callback URL, so these
  // keep an in-flight upgrade from landing on a 404 right after payment.
  async redirects() {
    return [
      { source: "/dashboard", destination: "/", permanent: false },
      { source: "/flow", destination: "/admin/flow", permanent: false },
    ];
  },
};

export default nextConfig;
