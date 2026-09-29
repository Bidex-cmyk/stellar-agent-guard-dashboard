import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The dashboard holds no secrets and no server state: every mutation is signed
  // in the operator's own browser wallet and broadcast straight to Soroban RPC.
  // There is deliberately no API route that touches a key.
  poweredByHeader: false,
  // `next build && next export` produces the static site Lighthouse CI audits.
  // The dashboard is a pure client-side consumer of Soroban RPC — every page
  // below is a client component tree with no server data dependency — so the
  // export is lossless for this app. Set from CI so a developer's local `next
  // build` keeps using the (faster) default output until they want an export.
  ...(process.env.EXPORT_BUILD === "true" ? { output: "export" as const } : {}),
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        // The service worker must never be cached by an intermediary: a pinned
        // worker would keep serving an old shell (and an old bypass list) after a
        // deploy. `Service-Worker-Allowed` keeps its scope at the site root even
        // though the script itself is a file.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // Served as a real manifest, and revalidated so an icon or colour change
        // is picked up instead of being pinned by the browser's manifest cache.
        source: "/manifest.json",
        headers: [
          { key: "Content-Type", value: "application/manifest+json" },
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default config;
