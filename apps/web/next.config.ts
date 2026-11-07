import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Screens render from the browser's realtime connection, so only validate
  // segments that explicitly opt in to instant navigation.
  experimental: { instantInsights: { validationLevel: "manual-warning" } },
  // Shared SpacetimeDB bindings ship as TypeScript source from the workspace.
  transpilePackages: ["@anywhere/stdb"],
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  async redirects() {
    return [
      { source: "/desktops", destination: "/machines", permanent: false },
      { source: "/workloads", destination: "/machines", permanent: false },
      { source: "/desktops/:id", destination: "/w/:id", permanent: false },
      { source: "/workloads/:id", destination: "/w/:id", permanent: false },
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
