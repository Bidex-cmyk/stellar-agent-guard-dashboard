/**
 * Unit tests for scripts/analyze-bundle.mjs — the collect/compare logic behind
 * the bundle-size workflow.
 *
 * The fixtures mirror the shape @next/bundle-analyzer writes (chunk assets with
 * `isInitialByEntrypoint`), so a regression in the per-route attribution here
 * would silently change what CI measures.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  chunkDeltas,
  computePages,
  renderReport,
  runCollect,
} from "../../scripts/analyze-bundle.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/analyze-bundle.mjs", import.meta.url));

interface AnalyzerAsset {
  label: string;
  isAsset?: boolean;
  parsedSize?: number;
  gzipSize?: number;
  isInitialByEntrypoint?: Record<string, boolean>;
}

function asset(
  label: string,
  bytes: number,
  gzipBytes: number,
  initialFor: string[],
): AnalyzerAsset {
  return {
    label: `static/chunks/${label}`,
    isAsset: true,
    parsedSize: bytes,
    gzipSize: gzipBytes,
    isInitialByEntrypoint: Object.fromEntries(initialFor.map((entry) => [entry, true])),
  };
}

/** A miniature but structurally faithful analyzer report. */
const assets: AnalyzerAsset[] = [
  asset("webpack.js", 1_000, 300, ["main-app"]),
  asset("runtime.js", 5_000, 2_000, ["main-app"]),
  asset("layout-shared.js", 4_000, 1_500, ["app/layout", "app/page", "app/configure/page"]),
  asset("app-page.js", 3_000, 1_000, ["app/page"]),
  asset("app-configure-page.js", 2_000, 800, ["app/configure/page"]),
  asset("route-shared.js", 9_000, 4_000, ["app/page", "app/configure/page"]),
  asset("style.css", 777, 555, ["app/page"]), // non-JS assets must be ignored
  { label: "static/chunks/lazy-only.js", parsedSize: 64, gzipSize: 32 }, // non-initial
];

test("computePages splits a route's own bundle from shared initial JS", () => {
  const pages = computePages(assets);
  assert.deepEqual(Object.keys(pages).sort(), ["/", "/configure"]);

  const home = pages["/"]!;
  // Own = chunks initial only for this route: app-page.js (3000). The
  // route-shared chunk (two routes) and the layout/runtime chunks are shared.
  assert.equal(home.ownJsBytes, 3_000);
  assert.equal(home.ownJsGzipBytes, 1_000);
  // Initial = own + route-shared + layout chain + main-app runtime:
  // 1000 + 5000 + 4000 + 3000 + 9000 = 22000 (the .css and the lazy chunk
  // never count).
  assert.equal(home.initialJsBytes, 22_000);
  assert.equal(home.initialJsGzipBytes, 8_800);

  const configure = pages["/configure"]!;
  assert.equal(configure.ownJsBytes, 2_000);
  assert.equal(configure.initialJsBytes, 21_000);
  assert.ok(home.initialChunks.every((label) => !label.endsWith("style.css")));
});

test("computePages attributes chunks across nested routes via the layout chain", () => {
  const nested = computePages([
    ...assets,
    asset("nested-page.js", 111, 44, ["app/configure/deploy/page"]),
    asset("nested-layout.js", 222, 88, ["app/configure/layout"]),
  ]);
  const route = nested["/configure/deploy"]!;
  assert.equal(route.ownJsBytes, 111);
  // Nested route also loads the nested layout and the root layout.
  assert.ok(route.initialChunks.includes("static/chunks/nested-layout.js"));
  assert.ok(route.initialChunks.includes("static/chunks/layout-shared.js"));
  assert.ok(route.initialChunks.includes("static/chunks/app-page.js") === false);
});

test("runCollect writes per-route JSON from an analyzer report", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  const report = join(dir, "client.json");
  const out = join(dir, "collected.json");
  writeFileSync(report, JSON.stringify(assets));
  const payload = runCollect({ analyzerReport: report, out });
  assert.equal(Object.keys(payload.pages).length, 2);

  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(onDisk.pages["/"].ownJsBytes, 3_000);
  assert.equal(payload.chunks[0]?.chunk, "route-shared.js"); // biggest gzip first
  assert.ok(payload.chunks.every((entry: { chunk: string }) => !entry.chunk.endsWith("style.css")));
});

test("renderReport enforces the budget and marks violations", () => {
  const current = {
    pages: {
      "/": {
        entrypoint: "app/page",
        initialChunks: [],
        ownChunks: [],
        initialJsBytes: 22_000,
        initialJsGzipBytes: 9_300,
        ownJsBytes: 3_000,
        ownJsGzipBytes: 1_000,
      },
    },
    chunks: [],
  };

  const pass = renderReport(current, null, { budgetBytes: 4_096, metric: "page" });
  assert.equal(pass.violations.length, 0);
  assert.match(pass.markdown, /<!-- bundle-size-report -->/);
  assert.match(pass.markdown, /Budget met/);
  assert.match(pass.markdown, /could not be built/); // no baseline → absolute sizes

  const fail = renderReport(current, null, { budgetBytes: 2_048, metric: "page" });
  assert.deepEqual(fail.violations, ["/"]);
  assert.match(fail.markdown, /Budget exceeded/);
  assert.match(fail.markdown, /exceeds 2\.0 kB/); // the total-initial warning too
});

test("renderReport switches the hard budget to gzipped initial JS with metric: initial", () => {
  const current = {
    pages: {
      "/": {
        entrypoint: "app/page",
        initialChunks: [],
        ownChunks: [],
        initialJsBytes: 22_000,
        initialJsGzipBytes: 9_300,
        ownJsBytes: 3_000,
        ownJsGzipBytes: 1_000,
      },
    },
    chunks: [],
  };
  const strict = renderReport(current, null, { budgetBytes: 8_192, metric: "initial" });
  assert.deepEqual(strict.violations, ["/"]);
  assert.match(strict.markdown, /initial JS \(gzip\) is over 8\.0 kB/);
});

test("chunkDeltas ranks movements and reports new and removed chunks", () => {
  const current = [
    { chunk: "grew.js", bytes: 0, gzipBytes: 500, initialFor: [] },
    { chunk: "new.js", bytes: 0, gzipBytes: 700, initialFor: [] },
  ];
  const baseline = [
    { chunk: "grew.js", bytes: 0, gzipBytes: 460, initialFor: [] },
    { chunk: "gone.js", bytes: 0, gzipBytes: 300, initialFor: [] },
  ];
  const deltas = chunkDeltas(current, baseline, 10);
  assert.deepEqual(
    deltas.map((entry: { chunk: string }) => entry.chunk),
    ["new.js", "gone.js", "grew.js"],
  );
  assert.equal(deltas[0]?.baselineBytes, null);
  assert.equal(deltas[1]?.currentBytes, 0);
  assert.equal(deltas[2]?.diff, 40);
});

test("renderReport shows deltas against a baseline when one is available", () => {
  const page = (own: number, gzip: number) => ({
    entrypoint: "app/page",
    initialChunks: [],
    ownChunks: [],
    initialJsBytes: own * 10,
    initialJsGzipBytes: gzip,
    ownJsBytes: own,
    ownJsGzipBytes: 0,
  });
  const current = { pages: { "/": page(4_000, 11_000) }, chunks: [] };
  const baseline = { pages: { "/": page(3_000, 10_000) }, chunks: [] };
  const report = renderReport(current, baseline, { budgetBytes: 100_000, metric: "page" });
  assert.match(report.markdown, /\+1\.0 kB/);
  assert.match(report.markdown, /\+1\.0 kB/); // gzip delta column
  assert.doesNotMatch(report.markdown, /could not be built/);
});

test("the compare CLI exits 1 when a page bundle is over budget", () => {
  // The bundle-size workflow gates on this exit code — a violation that
  // reported itself but exited 0 would silently disable the 200 KB limit.
  const dir = mkdtempSync(join(tmpdir(), "bundle-cli-"));
  const current = join(dir, "collected.json");
  writeFileSync(
    current,
    JSON.stringify({
      pages: {
        "/": {
          entrypoint: "app/page",
          initialChunks: [],
          ownChunks: [],
          initialJsBytes: 22_000,
          initialJsGzipBytes: 9_300,
          ownJsBytes: 3_000,
          ownJsGzipBytes: 1_000,
        },
      },
      chunks: [],
    }),
  );

  const run = (budgetKb: string, out: string) =>
    spawnSync(
      process.execPath,
      [SCRIPT, "compare", "--current", current, "--budget-kb", budgetKb, "--metric", "page", "--out", out],
      { encoding: "utf8" },
    );

  const ok = run("200", join(dir, "ok.md"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(dir, "ok.md"), "utf8"), /Budget met/);

  const over = run("1", join(dir, "over.md"));
  assert.equal(over.status, 1, over.stderr);
  const markdown = readFileSync(join(dir, "over.md"), "utf8");
  assert.match(markdown, /Budget exceeded/);
  assert.match(markdown, /`\/`/);
});
