#!/usr/bin/env node
/**
 * CHANGELOG.md generator, driven by conventional commit messages.
 *
 * The changelog is a record of what a *release* contained, so this script reads
 * the commits since the last release tag (`git describe --tags --abbrev=0`, or the
 * whole history when nothing has been tagged yet), groups them by the type their
 * subject declares, and renders a "[Keep a Changelog]" document. Issue references
 * are turned into links, so a reader can go from a line in the changelog to the
 * issue that asked for it.
 *
 * A commit only lands in the changelog if it *declares* what it is — `feat:`,
 * `fix(scope):`, `docs!:`. Merge commits, `fixup!`/`squash!` commits and anything
 * else that does not match are counted and reported, never silently rendered as
 * something they are not.
 *
 * Usage:
 *   node scripts/generate-changelog.mjs                      # rewrite CHANGELOG.md
 *   node scripts/generate-changelog.mjs --stdout             # preview it instead
 *   node scripts/generate-changelog.mjs --version 0.2.0 --date 2026-09-25
 *   node scripts/generate-changelog.mjs --help
 *
 * The parsing and rendering halves are exported as pure functions so they can be
 * unit tested without a git repository; only `collectFromGit` and `main` touch
 * the outside world.
 *
 * [Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Record and field separators for `git log`: neither byte can appear in a subject. */
const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const GIT_LOG_FORMAT = `%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`;

export const UNRELEASED = "Unreleased";

/**
 * The changelog's four sections, in the order they are rendered.
 *
 * `types` are the conventional-commit types that feed each section. The section
 * marked `catchAll` (Maintenance) also takes every type not claimed by another
 * section, so a conventional commit is never dropped for using a prefix this list
 * has not heard of yet.
 */
export const SECTIONS = [
  { title: "Features", types: ["feat", "feature"], catchAll: false },
  { title: "Bug Fixes", types: ["fix"], catchAll: false },
  { title: "Documentation", types: ["docs", "doc"], catchAll: false },
  {
    title: "Maintenance",
    types: ["chore", "ci", "build", "refactor", "perf", "test", "style", "revert", "deps"],
    catchAll: true,
  },
];

const CONVENTIONAL_SUBJECT =
  /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?:\s*(?<description>.+)$/;

const DEFAULT_HEADER = [
  "# Changelog",
  "",
  "All notable changes to this project are documented in this file.",
  "",
  "The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and entries are",
  "derived from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) by",
  "`npm run changelog`.",
];

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * A commit subject read as a conventional commit, as `parseCommit` returns it.
 *
 * @typedef {object} Commit
 * @property {string} type the conventional type, lower-cased
 * @property {string | null} scope the part in parentheses, or null
 * @property {boolean} breaking whether the commit declares a breaking change
 * @property {string} description the subject with the type and scope removed
 * @property {string[]} issues every `#123` the description references
 */

/**
 * A `Commit` together with the hash it was read from.
 *
 * @typedef {Commit & { hash: string }} LoggedCommit
 */

/**
 * Every `#123` in a piece of plain text, de-duplicated and in order.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function issueNumbers(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(/(?:^|[^\w#/])#(\d+)\b/g)) {
    const number = match[1];
    if (!found.includes(number)) found.push(number);
  }
  return found;
}

/**
 * Turn `#123` references in *plain text* into links to the issue.
 *
 * The input must be a raw commit description, not Markdown: an already-linked
 * `[#123](…)` would have its number linked a second time.
 *
 * @param {string} text
 * @param {string | null} [repositoryUrl]
 * @returns {string}
 */
export function linkIssues(text, repositoryUrl) {
  if (!repositoryUrl) return text;
  return String(text ?? "").replace(
    /(^|[^\w#/])#(\d+)\b/g,
    (_match, prefix, number) => `${prefix}[#${number}](${repositoryUrl}/issues/${number})`,
  );
}

/**
 * Read one commit subject as a conventional commit.
 *
 * Returns `null` for anything that does not declare a type — including merge
 * commits, which are an artefact of how the branch landed rather than a change in
 * their own right. `body` is consulted only for a `BREAKING CHANGE:` footer, which
 * conventional commits treat as equivalent to the `!` marker.
 *
 * @param {string} [subject]
 * @param {string} [body]
 * @returns {Commit | null}
 */
export function parseCommit(subject, body = "") {
  const text = String(subject ?? "").trim();
  if (!text) return null;
  if (/^Merge\b/i.test(text)) return null;
  if (/^(?:fixup|squash|amend)!/i.test(text)) return null;

  const match = CONVENTIONAL_SUBJECT.exec(text);
  if (!match?.groups) return null;

  const description = match.groups.description.trim();
  const breaking =
    Boolean(match.groups.breaking) || /^BREAKING[ -]CHANGE:/m.test(String(body ?? ""));

  return {
    type: match.groups.type.toLowerCase(),
    scope: match.groups.scope?.trim() ? match.groups.scope.trim() : null,
    breaking,
    description,
    issues: issueNumbers(description),
  };
}

/**
 * Parse the raw `git log` output produced with `GIT_LOG_FORMAT`.
 *
 * @param {string} rawLog
 * @returns {{ commits: LoggedCommit[], skipped: number }}
 */
export function parseCommits(rawLog) {
  const commits = [];
  let skipped = 0;

  for (const record of String(rawLog ?? "").split(RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const [hash = "", subject = "", body = ""] = trimmed.split(FIELD_SEPARATOR);
    const parsed = parseCommit(subject, body);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    commits.push({ hash: hash.trim(), ...parsed });
  }

  return { commits, skipped };
}

/**
 * Bucket commits into the four sections, dropping empty ones.
 *
 * @param {LoggedCommit[]} commits
 * @returns {{ title: string, commits: LoggedCommit[] }[]}
 */
export function groupCommits(commits) {
  const claimed = new Set(SECTIONS.flatMap((section) => section.types));
  return SECTIONS.map((section) => ({
    title: section.title,
    commits: commits.filter(
      (commit) =>
        section.types.includes(commit.type) || (section.catchAll && !claimed.has(commit.type)),
    ),
  })).filter((section) => section.commits.length > 0);
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderEntry(commit, repositoryUrl) {
  const scope = commit.scope ? `**${commit.scope}**: ` : "";
  const breaking = commit.breaking ? "**BREAKING:** " : "";
  const description = linkIssues(commit.description, repositoryUrl);

  // The issue numbers already rendered as part of the description are not
  // repeated; only ones the description mentioned some other way are appended.
  const extra = (commit.issues ?? [])
    .filter((number) => !description.includes(`#${number}`))
    .map((number) => `[#${number}](${repositoryUrl}/issues/${number})`);

  const suffix = [...extra, commit.hash ? `\`${commit.hash.slice(0, 7)}\`` : ""].filter(Boolean);
  return `- ${breaking}${scope}${description}${suffix.length > 0 ? ` (${suffix.join(", ")})` : ""}`;
}

/**
 * Render a complete Keep a Changelog document.
 *
 * Pure: the date and the repository URL are inputs, so the same commits always
 * produce the same bytes.
 *
 * @param {object} options
 * @param {string} [options.version]
 * @param {string | null} [options.date]
 * @param {LoggedCommit[]} [options.commits]
 * @param {string | null} [options.repositoryUrl]
 * @param {string | null} [options.previousTag]
 * @param {string[]} [options.header]
 * @returns {string}
 */
export function renderChangelog(options) {
  const {
    version = UNRELEASED,
    date = null,
    commits = [],
    repositoryUrl = null,
    previousTag = null,
    header = DEFAULT_HEADER,
  } = options ?? {};

  const isUnreleased = version === UNRELEASED;
  const releasedOn = isUnreleased ? null : (date ?? new Date().toISOString().slice(0, 10));

  const lines = [...header, ""];
  lines.push(isUnreleased ? `## [${UNRELEASED}]` : `## [${version}] - ${releasedOn}`);
  lines.push("");

  const groups = groupCommits(commits);
  if (groups.length === 0) {
    lines.push("_Nothing recorded yet._");
    lines.push("");
  }
  for (const group of groups) {
    lines.push(`### ${group.title}`);
    lines.push("");
    for (const commit of group.commits) {
      lines.push(renderEntry(commit, repositoryUrl));
    }
    lines.push("");
  }

  if (isUnreleased && previousTag && repositoryUrl) {
    lines.push(`[${UNRELEASED}]: ${repositoryUrl}/compare/${previousTag}...HEAD`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ── Git ────────────────────────────────────────────────────────────────────

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** The most recent release tag, or `null` when nothing has ever been tagged. */
export function lastReleaseTag(cwd = ROOT) {
  const tag = git(["describe", "--tags", "--abbrev=0"], cwd);
  return tag ? tag.trim() : null;
}

/**
 * The repository URL issues are linked against.
 *
 * `upstream` wins over `origin` on purpose: in a fork — which is where most
 * contributions start — the issues live on the canonical repository, not on the
 * contributor's copy.
 */
export function resolveRepositoryUrl(cwd = ROOT) {
  for (const remote of ["upstream", "origin"]) {
    const url = git(["remote", "get-url", remote], cwd);
    const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/i.exec(url ?? "");
    if (match) return `https://github.com/${match[1]}`;
  }
  return null;
}

/** Parse every conventional commit between `from` (exclusive, optional) and `to`. */
export function collectFromGit(options = {}) {
  const { from = null, to = "HEAD", cwd = ROOT } = options;
  const range = from ? [`${from}..${to}`] : [to];
  const raw = git(["log", `--format=${GIT_LOG_FORMAT}`, ...range], cwd);
  return parseCommits(raw ?? "");
}

// ── CLI ────────────────────────────────────────────────────────────────────

const HELP = `Generate CHANGELOG.md from conventional commits.

Usage:
  node scripts/generate-changelog.mjs [options]

Options:
  --from <ref>      start of the range (default: the last release tag, else all history)
  --to <ref>        end of the range (default: HEAD)
  --version <v>     version heading (default: ${UNRELEASED})
  --date <date>     release date, YYYY-MM-DD (default: today; released versions only)
  --repo-url <url>  repository URL used to link issues (default: derived from git remotes)
  --out <path>      file to write (default: CHANGELOG.md)
  --stdout          print the changelog instead of writing it
  --help            show this message
`;

function parseArgs(argv) {
  const options = { version: UNRELEASED, out: "CHANGELOG.md", stdout: false, help: false };
  const valued = new Set(["--from", "--to", "--version", "--date", "--repo-url", "--out"]);

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (!valued.has(argument)) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    index += 1;
    options[argument.slice(2)] = value;
  }

  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const previousTag = options.from ?? lastReleaseTag();
  const { commits, skipped } = collectFromGit({ from: previousTag, to: options.to });
  const repositoryUrl = options["repo-url"] ?? resolveRepositoryUrl();

  const markdown = renderChangelog({
    version: options.version,
    date: options.date,
    commits,
    repositoryUrl,
    previousTag: options.from ? null : previousTag,
  });

  const scope = previousTag ? `${previousTag}..${options.to ?? "HEAD"}` : "the full history";
  if (skipped > 0) {
    process.stderr.write(
      `generate-changelog: ${skipped} commit(s) in ${scope} are not conventional and were not ` +
        `recorded. Use "feat:", "fix:", "docs:" or "chore:" to have a commit appear in the changelog.\n`,
    );
  }

  if (options.stdout) {
    process.stdout.write(markdown);
    return 0;
  }

  const out = resolve(process.cwd(), options.out);
  writeFileSync(out, markdown);
  process.stdout.write(
    `generate-changelog: wrote ${out} — ${commits.length} commit(s) from ${scope}` +
      `${repositoryUrl ? `, issues linked to ${repositoryUrl}` : ", no repository URL found so issue references were left as text"}\n`,
  );
  return 0;
}

// Only run the CLI when executed directly: the unit tests import this module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
