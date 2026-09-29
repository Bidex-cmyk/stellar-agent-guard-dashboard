import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the browser suites.
 *
 * Two suites share this config and the dev server they drive:
 *
 *   tests/e2e  Functional specs (guard lifecycle, telemetry filtering and
 *              export) — run in CI via `npm run test:e2e`.
 *   tests/perf The telemetry throughput benchmark (issue #114) — run locally
 *              via `npm run test:perf`, deliberately not a CI gate because
 *              frame-rate assertions depend on the runner's GPU/CPU.
 *
 * The server is `next dev` rather than a production build: specs assert UI
 * behaviour, not bundle output (bundle sizes are the bundle-size workflow's
 * job), and a dev server needs no build step — `npm run test:e2e` works on a
 * fresh clone after `npm ci`.
 *
 * One worker, serially: the specs are stateful (a mocked chain per page,
 * wallet authorization persisted in `localStorage`), and the perf benchmark
 * needs an otherwise idle machine to measure frame rate honestly.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: {
    // Writes take ≥2s (the tx-inclusion poll) plus a chain re-read; dev-server
    // route compilation on first hit adds a little more on top.
    timeout: 15_000,
  },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    // Traces only on failure: they are the first thing a maintainer needs when
    // CI goes red, and are too heavy to keep for every run.
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
