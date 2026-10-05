#!/usr/bin/env node
/**
 * Dead-link checker for the repository's Markdown.
 *
 * The README, SPEC.md, CONTRIBUTING.md and `docs/` cross-reference each other by
 * relative path and by section anchor, and every one of those references is a
 * promise that survives only as long as someone remembers to update it. This
 * script turns that promise into a check: it walks every `.md`/`.mdx` file in the
 * repository, extracts inline links, images, HTML `href`/`src` attributes and
 * reference definitions, and fails when a referenced local file — or a heading
 * inside it — does not exist.
 *
 * What it deliberately does *not* do:
 *   - it never makes a network request, so external URLs (`https:`, `mailto:`,
 *     `data:`, protocol-relative) are skipped rather than fetched. A checker that
 *     hits the network fails on a plane and gets disabled; this one only has to
 *     be right about the repository.
 *   - it does not look inside fenced code blocks, inline code spans or HTML
 *     comments, because a link *shown* as an example (or commented out) is not a
 *     link. Without that, the documentation for this script would fail itself.
 *   - it does not require extensions. `[a](other)` resolves against
 *     `other.md`/`other.mdx`/`other/index.md`, which is how GitBook's SUMMARY
 *     navigation and most static-site generators resolve them.
 *
 * Usage:
 *   node scripts/check-doc-links.mjs [path …]   # default: the whole repository
 *   node scripts/check-doc-links.mjs --help
 *
 * Exits 0 when every internal reference resolves, 1 when any does not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

/** Directories that never hold hand-written documentation. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".cache",
  "out",
  "dist",
  "build",
  "vendor",
  "coverage",
]);

/**
 * Links carrying an explicit scheme, or protocol-relative ones, belong to another
 * host: not this script's business. A Windows drive letter would match the scheme
 * shape, but no such path is walked here.
 */
const EXTERNAL_LINK = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

/** A link that is standing in for a real one (`](...)`, `](#`) is not a link yet. */
const PLACEHOLDERS = new Set(["", "...", "#", "#...", "{...}"]);

/** `[text](target "optional title")`, plus the image form `![alt](target)`. */
const INLINE_LINK = /!?\[[^\]]*\]\(\s*([^)]*?)\s*\)/g;

/** `[label]: target` — reference-style definitions resolve the same way. */
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(\S+)/gm;

/** `<a href="…">` and `<img src="…">`, which the badges and the logo use. */
const HTML_ATTRIBUTE = /\b(?:href|src)\s*=\s*["']([^"']+)["']/g;

/** Explicit `<a id="…">`/`<a name="…">` targets, which are valid anchors too. */
const HTML_ANCHOR = /<a\s[^>]*(?:id|name)\s*=\s*["']([^"']+)["']/gi;

// ── File discovery ─────────────────────────────────────────────────────────

/** Every `.md`/`.mdx` file under `directory`, in a stable order. */
function listMarkdownFiles(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      listMarkdownFiles(path, found);
      continue;
    }
    if (MARKDOWN_EXTENSIONS.has(extname(entry.name))) found.push(path);
  }
  return found;
}

// ── Redaction ──────────────────────────────────────────────────────────────

/**
 * Blank out fenced code blocks, inline code spans and HTML comments, keeping the
 * line structure (and the column positions, where it is cheap) intact so reported
 * line numbers still point at the original source.
 */
function redact(source) {
  const lines = source.split("\n");
  const out = [];
  let fence = null;
  let insideComment = false;

  for (const raw of lines) {
    let line = raw;

    if (fence) {
      out.push("");
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }

    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = opening[1].slice(0, 3);
      out.push("");
      continue;
    }

    if (insideComment) {
      const end = line.indexOf("-->");
      if (end === -1) {
        out.push("");
        continue;
      }
      insideComment = false;
      line = line.slice(end + 3);
    }

    line = line.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
    const open = line.indexOf("<!--");
    if (open !== -1) {
      insideComment = true;
      line = line.slice(0, open);
    }

    // Inline code is documentation *about* syntax: `` `[text](path)` `` shows a
    // link, it does not make one.
    line = line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));

    out.push(line);
  }

  return out.join("\n");
}

// ── Anchors ────────────────────────────────────────────────────────────────

/**
 * GitHub's heading → anchor algorithm, which is what a `#fragment` in a Markdown
 * file actually resolves against:
 *   - lowercase;
 *   - drop everything that is not a letter, a digit, a space, `_` or `-`
 *     (so `—` disappears and leaves its surrounding spaces behind);
 *   - turn each remaining space into `-`, *without* collapsing runs — which is why
 *     the heading "Enforcement scope — …" becomes `enforcement-scope--read-…`
 *     with two hyphens;
 *   - suffix repeats with `-1`, `-2`, … in document order.
 */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a Markdown file offers: heading slugs plus explicit HTML ids. */
function anchorsOf(source) {
  const slugs = new Set();
  const counts = new Map();
  const explicit = new Set();
  let fence = null;

  for (const raw of source.split("\n")) {
    const line = raw.replace(/\s+$/, "");

    if (fence) {
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = opening[1].slice(0, 3);
      continue;
    }

    for (const match of line.matchAll(HTML_ANCHOR)) explicit.add(match[1]);

    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;

    const base = slugify(heading[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }

  return { slugs, explicit };
}

// ── Link extraction and resolution ─────────────────────────────────────────

/** A link target with its optional title removed and surrounding `<>` stripped. */
function cleanTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.includes(">")) {
    target = target.slice(1, target.indexOf(">"));
  }
  const title = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/.exec(target);
  if (title) target = target.slice(0, title.index);
  return target.trim();
}

/** Percent-decoding, tolerating a malformed escape rather than throwing on it. */
function decode(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** The 1-based line a character offset falls on. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Every candidate reference in one file, with the line it came from. */
function linksIn(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const pattern of [INLINE_LINK, HTML_ATTRIBUTE]) {
      for (const match of line.matchAll(pattern)) {
        found.push({ raw: match[1], line: index + 1 });
      }
    }
  });
  for (const match of text.matchAll(REFERENCE_DEFINITION)) {
    found.push({ raw: match[1], line: lineOf(text, match.index) });
  }
  return found;
}

/** Does `path` exist as a file or directory? */
function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one link target against the file that contains it.
 *
 * Returns `null` when the target is out of scope (external, a placeholder, an
 * anchorless `#`), or a human-readable reason when the target is broken.
 */
function checkTarget({ raw, file, anchorCache }) {
  const target = cleanTarget(raw);
  if (PLACEHOLDERS.has(target)) return null;
  if (EXTERNAL_LINK.test(target)) return null;
  // A template placeholder such as `{{docsUrl}}` is not a path yet.
  if (target.includes("{{") || target.includes("}}")) return null;

  const hash = target.indexOf("#");
  let pathPart = hash === -1 ? target : target.slice(0, hash);
  const fragment = decode(hash === -1 ? "" : target.slice(hash + 1));
  const query = pathPart.indexOf("?");
  if (query !== -1) pathPart = pathPart.slice(0, query);
  pathPart = decode(pathPart);

  if (pathPart === "") {
    if (fragment === "") return null;
    return checkAnchor({ file, fragment, anchorCache });
  }

  const from = dirname(file);
  let resolved = resolve(from, pathPart);
  if (!resolved.startsWith(ROOT + sep) && resolved !== ROOT) {
    return `"${target}" points outside the repository`;
  }

  if (!exists(resolved)) {
    // Extension-less references (`[a](other)`, `[a](concepts/)`) are the norm in
    // GitBook navigation, so try the shapes a static site would try.
    const fallbacks = [
      `${resolved}.md`,
      `${resolved}.mdx`,
      join(resolved, "index.md"),
      join(resolved, "README.md"),
    ];
    const hit = fallbacks.find((candidate) => exists(candidate));
    if (!hit) {
      return `"${target}" does not exist`;
    }
    resolved = hit;
  }

  if (fragment === "") return null;

  // A directory has no headings of its own; only a Markdown file can be anchored.
  if (statSync(resolved).isDirectory()) return null;
  if (!MARKDOWN_EXTENSIONS.has(extname(resolved))) return null;

  return checkAnchor({ file: resolved, fragment, anchorCache });
}

/** Is `fragment` a real anchor in `file`? */
function checkAnchor({ file, fragment, anchorCache }) {
  let anchors = anchorCache.get(file);
  if (!anchors) {
    anchors = anchorsOf(readFileSync(file, "utf8"));
    anchorCache.set(file, anchors);
  }

  const wanted = fragment.toLowerCase();
  const matches = (value) => value === fragment || value.toLowerCase() === wanted;

  if ([...anchors.slugs].some(matches)) return null;
  if ([...anchors.explicit].some(matches)) return null;

  const where = relative(ROOT, file);
  return `"#${fragment}" is not a heading in ${where}`;
}

// ── Entry point ────────────────────────────────────────────────────────────

const HELP = `Check every internal link in this repository's Markdown.

Usage:
  node scripts/check-doc-links.mjs [path …]   # default: the whole repository
  node scripts/check-doc-links.mjs --help
`;

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const requested = argv.filter((argument) => !argument.startsWith("-"));
  const targets =
    requested.length > 0 ? requested.map((path) => resolve(process.cwd(), path)) : [ROOT];

  const files = [];
  for (const target of targets) {
    if (!exists(target)) {
      process.stderr.write(`check-doc-links: no such path: ${target}\n`);
      return 1;
    }
    if (statSync(target).isDirectory()) {
      files.push(...listMarkdownFiles(target));
    } else if (MARKDOWN_EXTENSIONS.has(extname(target))) {
      files.push(target);
    }
  }

  const unique = [...new Set(files)].sort();
  const anchorCache = new Map();
  const problems = [];
  let checked = 0;

  for (const file of unique) {
    const text = redact(readFileSync(file, "utf8"));
    for (const link of linksIn(text)) {
      checked += 1;
      const reason = checkTarget({ raw: link.raw, file, anchorCache });
      if (reason) problems.push({ file, line: link.line, reason });
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${relative(ROOT, problem.file)}:${problem.line}: ${problem.reason}\n`);
    }
    process.stderr.write(
      `\n${problems.length} broken reference(s) in ${unique.length} markdown file(s) ` +
        `(${checked} reference(s) checked).\n`,
    );
    return 1;
  }

  process.stdout.write(
    `check-doc-links: ${checked} internal reference(s) across ${unique.length} markdown file(s) all resolve.\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
