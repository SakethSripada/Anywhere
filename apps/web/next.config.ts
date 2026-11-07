import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Shared SpacetimeDB bindings ship as TypeScript source from the workspace.
  transpilePackages: ["@anywhere/stdb"],
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  // The OAuth consent page must never render inside someone else's frame (clickjacking).
  // Caddy sets this site-wide in production; this covers `next dev` and `next start`.
  async headers() {
    return [
      {
        source: "/connect",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
