import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: require("node:path").join(__dirname, ".."),
  turbopack: { root: require("node:path").join(__dirname, "..") },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-src 'self'; object-src 'none'; base-uri 'self'",
          },
        ],
      },
    ];
  },
};
export default config;
