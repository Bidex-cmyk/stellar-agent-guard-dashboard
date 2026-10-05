/**
 * Diff a committed Phase 3 run record against a freshly emitted one, using the
 * two-tier rule defined in `lib/guard/proofRun.ts`.
 *
 * The rule, in one line each:
 *
 *   invariant — assertion names, assertion outcomes, scenario count, contract
 *               presence and run outcome. These MUST match on a re-run. A
 *               mismatch means the committed record no longer describes what
 *               this code does, which is a real finding.
 *   volatile  — `runDate`, `gitSha`, transaction hashes, ledger numbers and the
 *               contract ids of a freshly deployed instance. These are EXPECTED
 *               to differ: a re-run deploys a new instance and lands in later
 *               ledgers, so churn here is evidence the run was live.
 *
 * Usage:
 *   node scripts/compare-proof-run.ts [--committed <path>] [--fresh <path>]
 *
 * Defaults: `--committed tests/fixtures/phase3-proof.run.json`,
 *           `--fresh tests/fixtures/phase3-proof.run.fresh.json`.
 *
 * Exit code 0 when the invariant tier matches, 1 when it does not. Volatile
 * differences never change the exit code.
 */

import { readFile } from "node:fs/promises";
import {
  RUN_RECORD_PATH,
  compareRunRecords,
  type RunComparison,
  type RunRecord,
} from "../lib/guard/proofRun.ts";

const DEFAULT_FRESH_PATH = "tests/fixtures/phase3-proof.run.fresh.json";

function parseArgs(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token || !token.startsWith("--")) continue;
    const body = token.slice(2);
    const separator = body.indexOf("=");
    if (separator !== -1) {
      flags.set(body.slice(0, separator), body.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      flags.set(body, value);
      index++;
    } else {
      flags.set(body, "");
    }
  }
  return flags;
}

async function load(path: string): Promise<RunRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a run record object`);
  }
  const record = parsed as Partial<RunRecord>;
  if (!Array.isArray(record.assertions) || typeof record.contractIds !== "object") {
    throw new Error(`${path} is not a run record: missing assertions[] or contractIds{}`);
  }
  return record as RunRecord;
}

function truncate(text: string, limit = 160): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function report(comparison: RunComparison, committedPath: string, freshPath: string): void {
  console.log(`committed  ${committedPath}`);
  console.log(`fresh      ${freshPath}`);
  console.log("");
  if (comparison.invariantMismatches.length === 0) {
    console.log("invariant tier — MUST match, and does:");
    console.log("  all assertion names, assertion outcomes, the scenario count, contract");
    console.log("  presence and the run outcome are unchanged.");
  } else {
    console.log("invariant tier — MUST match, and does NOT:");
    for (const difference of comparison.invariantMismatches) {
      console.log(`  ${difference.field}`);
      console.log(`    committed  ${truncate(difference.committed)}`);
      console.log(`    fresh      ${truncate(difference.fresh)}`);
    }
  }
  console.log("");
  if (comparison.volatileChanged.length === 0) {
    console.log("volatile tier — EXPECTED churn, but nothing moved:");
    console.log("  a record that does not churn is a record that was not re-run.");
  } else {
    console.log(
      `volatile tier — EXPECTED churn, ${comparison.volatileChanged.length} field(s) moved:`,
    );
    for (const difference of comparison.volatileChanged) {
      console.log(`  ${difference.field}`);
      console.log(`    committed  ${truncate(difference.committed)}`);
      console.log(`    fresh      ${truncate(difference.fresh)}`);
    }
  }
  console.log("");
  console.log(
    comparison.ok
      ? "RESULT  MATCH — the committed record still describes this code."
      : "RESULT  MISMATCH — the committed record no longer describes this code.",
  );
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const committedPath = flags.get("committed") || RUN_RECORD_PATH;
  const freshPath = flags.get("fresh") || DEFAULT_FRESH_PATH;

  const committed = await load(committedPath);
  const fresh = await load(freshPath);
  const comparison = compareRunRecords(committed, fresh);
  report(comparison, committedPath, freshPath);
  if (!comparison.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
