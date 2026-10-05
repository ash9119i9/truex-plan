import type { NextConfig } from "next";
const config: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
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
