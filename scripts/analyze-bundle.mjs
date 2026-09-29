#!/usr/bin/env node
/**
 * Bundle-size collector and comparator for `.github/workflows/bundle-size.yml`.
 *
 * Two subcommands, whose pure helpers are unit-tested in
 * `tests/unit/bundleSize.test.ts`:
 *
 *   collect  Reads `.next/analyze/client.json` — the machine-readable report
 *            @next/bundle-analyzer writes for `ANALYZE=true next build
 *            --webpack` — and derives, per route, the JavaScript that page
 *            actually ships: the chunks exclusive to that route ("page
 *            bundle") and the full set of initial chunks the browser must
 *            download before it can render it ("initial JS", shared runtime
 *            included). Writes the result as JSON.
 *
 *   compare  Diffs two collected files (baseline vs pull request), renders the
 *            markdown report posted as the PR comment — per-route size table
 *            with deltas, plus the biggest chunk movements — and enforces the
 *            200 KB budget. Exits non-zero when a page bundle is over budget,
 *            which is what fails CI.
 *
 * Budget interpretation, stated plainly because it decides whether CI is red:
 * the *hard* 200 KB limit applies to the page bundle — the JavaScript a route
 * contributes on its own, beyond the shared framework/vendor chunks every page
 * loads. The larger shared total is reported for every route and the report
 * carries an explicit warning line whenever total initial JS crosses 200 KB
 * (the "hard limit warning" from the issue this serves). Pass
 * `--metric initial` to apply the hard budget to gzipped total initial JS
 * instead, if a maintainer wants the stricter gate.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const REPORT_MARKER = "<!-- bundle-size-report -->";

// ── collect ────────────────────────────────────────────────────────────────

/**
 * Turn the analyzer's chunk list into per-route facts.
 *
 * An asset carries `isInitialByEntrypoint`: which webpack entrypoints load it
 * before any interaction. A route's full initial set is its own entrypoint's
 * chunks plus every ancestor entrypoint's (root layout chain, then the
 * `main-app` runtime for App Router routes, `main` for Pages Router ones).
 * The page bundle is the set of chunks initial *only* for that route.
 *
 * @param {Array<{label: string, parsedSize?: number, gzipSize?: number, isAsset?: boolean, isInitialByEntrypoint?: Record<string, boolean>}>} assets
 * @returns {Record<string, {entrypoint: string, initialChunks: string[], ownChunks: string[], initialJsBytes: number, initialJsGzipBytes: number, ownJsBytes: number, ownJsGzipBytes: number}>}
 */
export function computePages(assets) {
  const byEntrypoint = new Map();
  const chunkInitial = new Map();
  for (const asset of assets) {
    if (!asset.isAsset || !asset.label) continue;
    if (!asset.label.endsWith(".js")) continue;
    const initial = Object.keys(asset.isInitialByEntrypoint ?? {}).filter(
      (entry) => asset.isInitialByEntrypoint[entry],
    );
    chunkInitial.set(asset.label, initial);
    for (const entry of initial) {
      if (!byEntrypoint.has(entry)) byEntrypoint.set(entry, []);
      byEntrypoint.get(entry).push(asset.label);
    }
  }

  const routeEntrypoints = [...byEntrypoint.keys()]
    .filter((entry) => entry.startsWith("app/") && entry.endsWith("/page"))
    .filter((entry) => !entry.includes("_global-error") && !entry.includes("_not-found"));

  /** Layout/runtime entrypoints a route transitively loads. */
  const ancestorsOf = (entry) => {
    const chain = [];
    // Every App Router route pulls the root layout; deeper layouts would appear
    // as `app/<dir>/layout` and are included when their directory prefixes the
    // route's entrypoint.
    for (const candidate of byEntrypoint.keys()) {
      if (candidate === "main-app" || candidate === "main") continue;
      if (!candidate.endsWith("/layout")) continue;
      const base = candidate.slice(0, -"/layout".length); // e.g. "app" or "app/configure"
      if (entry === base || entry.startsWith(`${base}/`)) chain.push(candidate);
    }
    chain.push(entry.startsWith("pages/") ? "main" : "main-app");
    return chain;
  };

  const pages = {};
  for (const entry of routeEntrypoints) {
    const route = routeOfEntrypoint(entry);
    // The route's own chunks first, then everything an ancestor entrypoint
    // (layout chain, main-app runtime) contributes.
    const initialSet = new Set(byEntrypoint.get(entry) ?? []);
    for (const ancestor of ancestorsOf(entry)) {
      for (const label of byEntrypoint.get(ancestor) ?? []) initialSet.add(label);
    }
    const own = [...initialSet].filter(
      (label) => chunkInitial.get(label)?.length === 1 && chunkInitial.get(label)?.[0] === entry,
    );
    pages[route] = {
      entrypoint: entry,
      initialChunks: [...initialSet].sort(),
      ownChunks: own.sort(),
      ...sizeOf(assets, initialSet),
      ownJsBytes: bytesOf(assets, own),
      ownJsGzipBytes: gzipOf(assets, own),
    };
  }
  return pages;
}

/** Chunk-level sizes plus which entrypoints call them initial. */
export function collectChunks(assets) {
  return assets
    .filter((asset) => asset.isAsset && asset.label?.endsWith(".js"))
    .map((asset) => ({
      chunk: asset.label.replace(/^static\/chunks\//, ""),
      bytes: asset.parsedSize ?? 0,
      gzipBytes: asset.gzipSize ?? 0,
      initialFor: Object.keys(asset.isInitialByEntrypoint ?? {}).filter(
        (entry) => asset.isInitialByEntrypoint[entry],
      ),
    }))
    .sort((a, b) => b.gzipBytes - a.gzipBytes);
}

function routeOfEntrypoint(entry) {
  // "app/configure/page" -> "/configure", "app/page" -> "/"
  const withoutSuffix = entry.replace(/\/page$/, "");
  const route = withoutSuffix.replace(/^app/, "");
  return route === "" ? "/" : route;
}

function sizeOf(assets, labels) {
  const set = new Set(labels);
  let bytes = 0;
  let gzipBytes = 0;
  for (const asset of assets) {
    if (!set.has(asset.label)) continue;
    bytes += asset.parsedSize ?? 0;
    gzipBytes += asset.gzipSize ?? 0;
  }
  return { initialJsBytes: bytes, initialJsGzipBytes: gzipBytes };
}

const bytesOf = (assets, labels) => sizeOf(assets, labels).initialJsBytes;
const gzipOf = (assets, labels) => sizeOf(assets, labels).initialJsGzipBytes;

function readAnalyzerReport(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} is not the analyzer's chunk array — was ANALYZE=true set?`);
  }
  return parsed;
}

export function runCollect({ analyzerReport, out }) {
  const assets = readAnalyzerReport(analyzerReport);
  const payload = {
    generatedAt: new Date().toISOString(),
    analyzerReport,
    pages: computePages(assets),
    chunks: collectChunks(assets),
  };
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

// ── compare ────────────────────────────────────────────────────────────────

function loadCollected(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.pages) return null;
    return parsed;
  } catch {
    return null;
  }
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

function delta(currentBytes, baselineBytes) {
  if (baselineBytes === undefined) return "new";
  const diff = currentBytes - baselineBytes;
  if (diff === 0) return "—";
  return `${diff > 0 ? "+" : "−"}${kb(Math.abs(diff))}`;
}

/**
 * Markdown report for the PR comment.
 *
 * @param {{pages: Record<string, any>, chunks: any[]}} current
 * @param {{pages: Record<string, any>, chunks: any[]}|null} baseline
 * @param {{budgetBytes: number, metric: "page"|"initial"}} options
 */
export function renderReport(current, baseline, { budgetBytes, metric }) {
  const routes = Object.keys(current.pages).sort();
  const metricOf = (page) =>
    metric === "initial" ? page.initialJsGzipBytes : page.ownJsBytes;
  const budgetName = metric === "initial" ? "initial JS (gzip)" : "page bundle";

  const violations = routes.filter(
    (route) => metricOf(current.pages[route]) > budgetBytes,
  );
  const initialWarnings = routes.filter(
    (route) => current.pages[route].initialJsGzipBytes > budgetBytes,
  );

  const lines = [];
  lines.push(REPORT_MARKER);
  lines.push("## Bundle size report");
  lines.push("");
  if (baseline) {
    lines.push(`Baseline: \`${baseline.headCommit ?? "main"}\` — sizes below show the change against it.`);
  } else {
    lines.push(
      "Baseline for `main` could not be built on this run (expected while the analyzer setup is landing), so only absolute sizes are shown.",
    );
  }
  lines.push("");
  lines.push("| Route | Page bundle | vs main | Initial JS (raw) | Initial JS (gzip) | vs main (gzip) |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const route of routes) {
    const page = current.pages[route];
    const base = baseline?.pages?.[route];
    lines.push(
      `| \`${route}\` | ${kb(page.ownJsBytes)} | ${delta(page.ownJsBytes, base?.ownJsBytes)} | ` +
        `${kb(page.initialJsBytes)} | ${kb(page.initialJsGzipBytes)} | ` +
        `${delta(page.initialJsGzipBytes, base?.initialJsGzipBytes)} |`,
    );
  }
  lines.push("");

  // Biggest per-chunk movements — where a size change actually came from.
  const topMovers = chunkDeltas(current.chunks, baseline?.chunks ?? null, 10);
  if (topMovers.length > 0) {
    lines.push("### Largest chunk movements (gzip)");
    lines.push("");
    lines.push("| Chunk | main | PR | Δ |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const mover of topMovers) {
      lines.push(
        `| \`${mover.chunk}\` | ${mover.baselineBytes === null ? "—" : kb(mover.baselineBytes)} | ` +
          `${kb(mover.currentBytes)} | ${delta(mover.currentBytes, mover.baselineBytes ?? undefined)} |`,
      );
    }
    lines.push("");
  }

  if (initialWarnings.length > 0) {
    lines.push(
      `> ⚠️ **Hard limit warning:** total initial JS exceeds ${kb(budgetBytes)} for ` +
        `${initialWarnings.map((route) => `\`${route}\``).join(", ")} — ` +
        "the shared runtime and vendor chunks dominate that number.",
    );
    lines.push("");
  }

  if (violations.length > 0) {
    lines.push(
      `❌ **Budget exceeded:** ${budgetName} is over ${kb(budgetBytes)} for ` +
        `${violations.map((route) => `\`${route}\``).join(", ")}.`,
    );
  } else {
    lines.push(
      `✅ **Budget met:** every ${budgetName} is within ${kb(budgetBytes)}.`,
    );
  }
  lines.push("");

  return { markdown: `${lines.join("\n")}\n`, violations };
}

/** Per-chunk deltas sorted by absolute gzip movement, largest first. */
export function chunkDeltas(currentChunks, baselineChunks, limit = 10) {
  const baselineByChunk = new Map(
    (baselineChunks ?? []).map((chunk) => [chunk.chunk, chunk]),
  );
  const deltas = [];
  for (const chunk of currentChunks ?? []) {
    const base = baselineByChunk.get(chunk.chunk);
    deltas.push({
      chunk: chunk.chunk,
      currentBytes: chunk.gzipBytes,
      baselineBytes: base ? base.gzipBytes : null,
      diff: chunk.gzipBytes - (base ? base.gzipBytes : 0),
    });
    baselineByChunk.delete(chunk.chunk);
  }
  for (const [chunk, base] of baselineByChunk) {
    deltas.push({
      chunk,
      currentBytes: 0,
      baselineBytes: base.gzipBytes,
      diff: -base.gzipBytes,
    });
  }
  return deltas
    .filter((entry) => entry.baselineBytes === null || entry.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, limit);
}

export function runCompare({ baseline, current, budgetKb, metric, out }) {
  const currentData = loadCollected(current);
  if (!currentData) {
    throw new Error(
      `no collected bundle data at ${current} — run \`ANALYZE=true next build --webpack\` then \`collect\` first`,
    );
  }
  const baselineData = loadCollected(baseline);
  const { markdown, violations } = renderReport(currentData, baselineData, {
    budgetBytes: Math.round(budgetKb * 1024),
    metric,
  });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, markdown);
  }
  process.stdout.write(markdown);
  return { markdown, violations };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1];
      args[key] = value;
      index += 1;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "collect") {
    const out = args.out ?? "bundle-size.json";
    const analyzerReport = args.report ?? ".next/analyze/client.json";
    if (!existsSync(analyzerReport)) {
      throw new Error(
        `${analyzerReport} not found — run \`ANALYZE=true npx next build --webpack\` first (the analyzer is only enabled when ANALYZE=true)`,
      );
    }
    const payload = runCollect({ analyzerReport, out });
    process.stdout.write(
      `collected ${Object.keys(payload.pages).length} route(s), ${payload.chunks.length} chunk(s) -> ${out}\n`,
    );
    return;
  }
  if (command === "compare") {
    const { violations } = runCompare({
      baseline: args.baseline,
      current: args.current,
      budgetKb: args["budget-kb"] ? Number(args["budget-kb"]) : 200,
      metric: args.metric === "initial" ? "initial" : "page",
      out: args.out,
    });
    // The workflow's budget gate is this exit code (see bundle-size.yml): a
    // report that says "Budget exceeded" while exiting 0 would never fail CI,
    // which is precisely the guard the 200 KB limit exists to provide.
    if (violations.length > 0) process.exitCode = 1;
    return;
  }
  process.stderr.write(
    "usage: analyze-bundle.mjs collect --out <file> [--report <client.json>]\n" +
      "       analyze-bundle.mjs compare --current <file> [--baseline <file>] [--budget-kb 200] [--metric page|initial] [--out report.md]\n",
  );
  process.exitCode = 2;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
