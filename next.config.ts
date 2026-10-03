import type { NextConfig } from "next";
import path from "node:path";
import bundleAnalyzer from "@next/bundle-analyzer";

// ── Browser build compatibility for the webpack toolchain ──────────────────
// Webpack (reached only via `ANALYZE=true next build --webpack`, the build that
// feeds @next/bundle-analyzer) refuses to resolve a bare `node:` scheme for a
// browser target and fails the whole compile. The SDK's `dist/tx.js` statically
// imports `createHash` from `node:crypto` — helpers the dashboard never calls in
// the browser (its own `predictContractId` hashes with Web Crypto) — so this
// plugin rewrites that one specifier to a small sync SHA-256 shim. It hooks
// `beforeResolve`, i.e. the request is rewritten *before* resolution, which is
// the one stage where the scheme has not yet been treated as an unreadable
// resource. Server runtimes (`nextRuntime` set) keep the real `node:crypto`.
type NodeCryptoResolveData = { request?: string } | null | undefined;
type BeforeResolveHook = {
  tap(name: string, callback: (data: NodeCryptoResolveData) => void): void;
};
type NodeCryptoShimCompiler = {
  hooks: {
    normalModuleFactory: {
      tap(
        name: string,
        callback: (factory: { hooks: { beforeResolve: BeforeResolveHook } }) => void,
      ): void;
    };
  };
};

function nodeCryptoShimPlugin(shimPath: string): { apply(compiler: NodeCryptoShimCompiler): void } {
  return {
    apply(compiler) {
      compiler.hooks.normalModuleFactory.tap("NodeCryptoShimPlugin", (factory) => {
        factory.hooks.beforeResolve.tap("NodeCryptoShimPlugin", (data) => {
          if (data && data.request === "node:crypto") data.request = shimPath;
        });
      });
    },
  };
}

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
  // Next 16 builds with Turbopack by default and treats a `webpack` key with no
  // `turbopack` config as a likely mistake (it errors the build). The webpack
  // key below is deliberate — it only runs for `--webpack` analysis builds —
  // and an explicit (empty) Turbopack config is how Next is told so.
  turbopack: {},
  webpack(config, { nextRuntime }) {
    if (!nextRuntime) {
      config.plugins.push(
        nodeCryptoShimPlugin(path.join(process.cwd(), "lib/compat/nodeCryptoShim.ts")),
      );
    }
    return config;
  },
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

// `ANALYZE=true` turns on @next/bundle-analyzer, which emits a machine-readable
// chunk report under `.next/analyze/` for `scripts/analyze-bundle.mjs` (and the
// bundle-size workflow) to turn into a per-page size table. The analyzer is a
// webpack plugin, so analysis builds must pass `--webpack` to `next build` on
// Turbopack-backed Next releases; ordinary builds are unaffected.
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
  openAnalyzer: false,
  analyzerMode: "json",
});

export default withBundleAnalyzer(config);
