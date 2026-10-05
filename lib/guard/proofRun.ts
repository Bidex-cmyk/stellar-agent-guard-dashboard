/**
 * The machine-readable shape a Phase 3 proof run emits, and the two-tier rule for
 * deciding whether a re-run "matches" the committed record.
 *
 * ## Why this exists
 *
 * `scripts/prove-phase3.ts` writes `tests/fixtures/phase3-proof.json`: a rich,
 * human-readable record whose whole point is that every hash in it is a real
 * testnet transaction. That richness is also why it cannot be compared across
 * runs — it is *supposed* to differ, because a re-run deploys a new instance,
 * mints again, freezes again and lands in later ledgers. Diffing it with `git
 * diff` produces noise, and "the diff was big" says nothing about whether the
 * run still proves anything.
 *
 * So the emit path projects that record onto a narrow **run record** whose whole
 * job is to be diffable:
 *
 * - **invariant tier** — the facts that must be identical on a re-run for the
 *   committed proof to still be a claim about this code: the assertion names,
 *   the assertion outcomes, the scenario count, whether a guard and a token
 *   contract were present at all, and the run outcome.
 * - **volatile tier** — the facts that *must* churn on a re-run, and whose churn
 *   is itself the evidence that the run was live: `runDate`, `gitSha`, the
 *   transaction hashes, the ledger numbers inside `actual`, and the contract ids
 *   of a freshly deployed instance.
 *
 * `compareRunRecords` implements exactly that split. A re-run is "the same" when
 * the invariant tier matches; a volatile mismatch is reported, never treated as
 * a failure.
 *
 * Everything in this module is pure except `resolveGitSha`, whose process
 * interaction is injectable so the shell-out can be stubbed in tests.
 */

import { execFileSync } from "node:child_process";

/** Bumped only when the run-record shape itself changes incompatibly. */
export const RUN_RECORD_SCHEMA_VERSION = 1;

/** Where `--emit` writes, relative to the repository root. */
export const RUN_RECORD_PATH = "tests/fixtures/phase3-proof.run.json";

export interface RunAssertion {
  /** Stable identifier, e.g. `freeze.status-reread-admin-frozen`. */
  name: string;
  pass: boolean;
  /** What was actually observed — always volatile, always kept. */
  actual: unknown;
}

export interface RunContractIds {
  guard: string;
  token: string;
}

export type RunOutcome = "passed" | "failed";

export interface RunRecord {
  schemaVersion: number;
  /** ISO-8601. Volatile: a re-run happens at a different time by definition. */
  runDate: string;
  /** Commit the run was made from, or null when it could not be determined. */
  gitSha: string | null;
  outcome: RunOutcome;
  /** Populated only when `outcome` is `failed`. */
  error: string | null;
  contractIds: RunContractIds;
  /** Step label -> transaction hash, for every step that broadcast one. */
  txHashes: Record<string, string>;
  assertions: RunAssertion[];
  note: string;
}

/**
 * The subset of `phase3-proof.json` the assertion set is derived from.
 *
 * Every field is optional and every field is `unknown`-shaped on purpose: this
 * reads a JSON document produced by a separate script, so a missing or
 * differently-shaped field must degrade to a failing assertion rather than throw.
 */
export interface ProofFacts {
  artifact?: unknown;
  guard?: unknown;
  token?: unknown;
  tokenCreate?: unknown;
  deploy?: unknown;
  initialize?: unknown;
  setPolicy?: unknown;
  trustline?: unknown;
  mint?: unknown;
  transferWhileUnfrozen?: unknown;
  freeze?: unknown;
  statusAfterFreeze?: unknown;
  checkWhileFrozen?: unknown;
  transferWhileFrozen?: unknown;
  unfreeze?: unknown;
  statusAfterUnfreeze?: unknown;
  transferAfterUnfreeze?: unknown;
  telemetry?: unknown;
  telemetryMissingFromScan?: unknown;
}

// ── small structural readers ───────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function field(value: unknown, key: string): unknown {
  return asRecord(value)[key];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hashOf(value: unknown): string {
  return text(field(value, "hash"));
}

/** `true` when a step was satisfied by reusing prior state rather than writing. */
function reused(value: unknown): boolean {
  return field(value, "reused") === true;
}

/**
 * A step counts as landed when it carries a transaction hash, or when it was
 * explicitly reused from a previous run. Both mean "the step is satisfied"; only
 * the first means "this run spent a transaction on it".
 */
function stepSatisfied(value: unknown): boolean {
  return reused(value) || hashOf(value).length > 0;
}

// ── the assertion set ──────────────────────────────────────────────────────

/**
 * One row per check the script actually performs, in the order the script makes
 * them. The names are the contract: they are the invariant half of the record,
 * so renaming one is a deliberate act that shows up as an invariant mismatch in
 * `compareRunRecords` rather than as silent drift.
 *
 * Note which rows can legitimately be `pass: false` on a successful run: the
 * reuse-aware steps (`deploy`, `initialize`, `policy`, `token.guard-funded`,
 * `freeze`, `unfreeze`) treat "reused from a previous run" as satisfaction,
 * because reuse is what makes the script idempotent, not a failure. Every other
 * row is only reachable as `false` from a *failed* run — the script throws before
 * writing `phase3-proof.json` in those cases, but `--emit` still writes a run
 * record, so a regression shows up here as a failing row rather than as silence.
 */
export function deriveAssertions(facts: ProofFacts): RunAssertion[] {
  const freezeReason = text(field(facts.transferWhileFrozen, "reason"));
  const frozenKind = text(field(facts.transferWhileFrozen, "kind"));
  const telemetryKinds = Array.isArray(field(facts.telemetry, "kinds"))
    ? (field(facts.telemetry, "kinds") as unknown[]).filter(
        (k): k is string => typeof k === "string",
      )
    : [];
  const missing = Array.isArray(facts.telemetryMissingFromScan)
    ? facts.telemetryMissingFromScan.filter((k): k is string => typeof k === "string")
    : [];
  const checkWhileFrozen = facts.checkWhileFrozen;
  const checkFrozenBlocked =
    Array.isArray(checkWhileFrozen) &&
    checkWhileFrozen.length === 2 &&
    checkWhileFrozen[0] === "Blocked" &&
    checkWhileFrozen[1] === "admin_frozen";

  return [
    {
      name: "artifact.pin-matches-chain",
      pass: field(facts.artifact, "ok") === true,
      actual: {
        pinnedHash: field(facts.artifact, "pinnedHash") ?? null,
        fetchedSha256: field(facts.artifact, "fetchedSha256") ?? null,
        bytes: field(facts.artifact, "fetchedBytes") ?? null,
      },
    },
    {
      name: "contract-presence.guard-and-token",
      pass: text(facts.guard).length > 0 && text(facts.token).length > 0,
      actual: { guard: text(facts.guard) || null, token: text(facts.token) || null },
    },
    {
      name: "deploy.runs-pinned-artifact",
      pass: field(facts.deploy, "verifiedAgainstPin") === true || reused(facts.deploy),
      actual: {
        guard: text(field(facts.deploy, "guard")) || null,
        verifiedAgainstPin: field(facts.deploy, "verifiedAgainstPin") ?? null,
        reused: reused(facts.deploy),
      },
    },
    {
      name: "initialize.landed",
      pass: stepSatisfied(facts.initialize),
      actual: { hash: hashOf(facts.initialize) || null, reused: reused(facts.initialize) },
    },
    {
      name: "policy.installed-via-console-form-path",
      pass: stepSatisfied(facts.setPolicy),
      actual: { hash: hashOf(facts.setPolicy) || null, reused: reused(facts.setPolicy) },
    },
    {
      name: "token.guard-funded",
      pass: stepSatisfied(facts.mint),
      actual: { hash: hashOf(facts.mint) || null, amount: field(facts.mint, "amount") ?? null },
    },
    {
      name: "transfer.allowed-while-unfrozen",
      pass: text(field(facts.transferWhileUnfrozen, "kind")) === "allowed",
      actual: {
        kind: text(field(facts.transferWhileUnfrozen, "kind")) || null,
        hash: hashOf(facts.transferWhileUnfrozen) || null,
      },
    },
    {
      name: "freeze.landed",
      pass: stepSatisfied(facts.freeze),
      actual: { hash: hashOf(facts.freeze) || null, reused: reused(facts.freeze) },
    },
    {
      name: "freeze.status-reread-reports-admin-frozen",
      pass: field(facts.statusAfterFreeze, "admin_frozen") === true,
      actual: {
        admin_frozen: field(facts.statusAfterFreeze, "admin_frozen") ?? null,
        last_heartbeat: field(facts.statusAfterFreeze, "last_heartbeat") ?? null,
        now: field(facts.statusAfterFreeze, "now") ?? null,
      },
    },
    {
      name: "freeze.check-view-blocked",
      pass: checkFrozenBlocked,
      actual: checkWhileFrozen ?? null,
    },
    {
      name: "transfer.blocked-while-frozen",
      pass: frozenKind === "blocked",
      actual: { kind: frozenKind || null, reason: freezeReason || null },
    },
    {
      name: "transfer.blocked-with-reason-admin-frozen",
      pass: freezeReason === "admin_frozen",
      actual: freezeReason || null,
    },
    {
      name: "unfreeze.landed",
      pass: stepSatisfied(facts.unfreeze),
      actual: { hash: hashOf(facts.unfreeze) || null, reused: reused(facts.unfreeze) },
    },
    {
      name: "unfreeze.status-reread-reports-admin-unfrozen",
      pass: field(facts.statusAfterUnfreeze, "admin_frozen") === false,
      actual: {
        admin_frozen: field(facts.statusAfterUnfreeze, "admin_frozen") ?? null,
        last_heartbeat: field(facts.statusAfterUnfreeze, "last_heartbeat") ?? null,
        now: field(facts.statusAfterUnfreeze, "now") ?? null,
      },
    },
    {
      name: "transfer.allowed-after-unfreeze",
      pass: text(field(facts.transferAfterUnfreeze, "kind")) === "allowed",
      actual: {
        kind: text(field(facts.transferAfterUnfreeze, "kind")) || null,
        hash: hashOf(facts.transferAfterUnfreeze) || null,
      },
    },
    {
      name: "telemetry.decoded-lifecycle-events",
      pass: telemetryKinds.length > 0,
      actual: { eventCount: field(facts.telemetry, "eventCount") ?? null, kinds: telemetryKinds },
    },
    {
      name: "telemetry.lifecycle-complete-in-scan-window",
      // An absent field is not the same as an empty list: absent means the run
      // never reached the scan, and reporting that as "nothing missing" is how
      // a partial run gets presented as a complete one.
      pass: Array.isArray(facts.telemetryMissingFromScan) && missing.length === 0,
      actual: missing,
    },
  ];
}

// ── the record ─────────────────────────────────────────────────────────────

export interface BuildRunRecordInput {
  runDate: string;
  gitSha: string | null;
  outcome: RunOutcome;
  error?: string | null;
  facts: ProofFacts;
  note: string;
}

/**
 * Every transaction the run's steps broadcast, keyed by step label.
 *
 * `deploy` is special: the deploy plan is several submissions under
 * `record.deploy.steps[]`, so its hashes are collected from there. A reused step
 * contributes no key at all rather than a placeholder, because "this run did not
 * spend a transaction here" is a fact worth being able to see.
 */
export function collectTxHashes(facts: ProofFacts): Record<string, string> {
  const hashes: Record<string, string> = {};
  const seen: Record<string, number> = {};
  const put = (label: string, hash: string): void => {
    if (hash.length === 0) return;
    const index = seen[label] ?? 0;
    seen[label] = index + 1;
    hashes[index === 0 ? label : `${label}[${index}]`] = hash;
  };

  const steps = field(facts.deploy, "steps");
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (field(step, "kind") === "submitted") put("deploy", hashOf(step));
    }
  } else {
    put("deploy", hashOf(facts.deploy));
  }

  for (const label of [
    "tokenCreate",
    "initialize",
    "setPolicy",
    "trustline",
    "mint",
    "transferWhileUnfrozen",
    "freeze",
    "unfreeze",
    "transferAfterUnfreeze",
  ] as const) {
    put(label, hashOf(facts[label]));
  }
  return hashes;
}

/**
 * JSON text for a run record.
 *
 * The bigint replacer is not a nicety: the proof script holds `bigint` ledger
 * timestamps in its record before it serialises, and plain `JSON.stringify`
 * throws on those. The record is emitted from here rather than from the caller's
 * ad-hoc replacer so that "this record is machine-parseable" is a property of
 * the module that owns the shape rather than of every place that writes one.
 */
export function serializeRunRecord(record: RunRecord, indent = 2): string {
  return JSON.stringify(
    record,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    indent,
  );
}

export function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  return {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    runDate: input.runDate,
    gitSha: input.gitSha,
    outcome: input.outcome,
    error: input.error ?? null,
    contractIds: {
      guard: text(input.facts.guard),
      token: text(input.facts.token),
    },
    txHashes: collectTxHashes(input.facts),
    assertions: deriveAssertions(input.facts),
    note: input.note,
  };
}

// ── the two-tier diff ──────────────────────────────────────────────────────

export interface TierDifference {
  field: string;
  committed: string;
  fresh: string;
}

export interface RunComparison {
  /** True when the invariant tier matched. Volatile churn does not clear it. */
  ok: boolean;
  /** Must be empty for a re-run to count as the same run. */
  invariantMismatches: TierDifference[];
  /** Expected to be non-empty. Reported, never treated as a failure. */
  volatileChanged: TierDifference[];
}

/**
 * Canonical JSON: object keys sorted recursively, `bigint` stringified.
 *
 * Sorting matters because a mismatch report is meant to be read by a human, and
 * "these two records differ" is noise if the difference is only key order.
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function render(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

/**
 * The invariant half: everything that must be identical on a re-run for the
 * committed record to still describe this code.
 */
export function invariantTier(record: RunRecord): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    outcome: record.outcome,
    scenarioCount: record.assertions.length,
    assertionNames: record.assertions.map((assertion) => assertion.name),
    assertionResults: record.assertions.map((assertion) => assertion.pass),
    contractPresence: {
      guard: record.contractIds.guard.length > 0,
      token: record.contractIds.token.length > 0,
    },
  };
}

/** The volatile half: the facts a re-run is *expected* to change. */
export function volatileTier(record: RunRecord): Record<string, unknown> {
  return {
    runDate: record.runDate,
    gitSha: record.gitSha,
    error: record.error,
    contractIds: record.contractIds,
    txHashes: record.txHashes,
    assertionActuals: record.assertions.map((assertion) => ({
      name: assertion.name,
      actual: assertion.actual,
    })),
  };
}

function diffTier(
  committed: Record<string, unknown>,
  fresh: Record<string, unknown>,
  fieldPrefix = "",
): TierDifference[] {
  const differences: TierDifference[] = [];
  for (const key of Object.keys(committed).sort()) {
    const label = fieldPrefix ? `${fieldPrefix}.${key}` : key;
    const before = committed[key];
    const after = fresh[key];
    if (render(before) !== render(after)) {
      differences.push({ field: label, committed: render(before), fresh: render(after) });
    }
  }
  return differences;
}

/**
 * Compare a committed run record with a freshly emitted one under the two-tier
 * rule. `ok` is true if and only if the invariant tier matches; volatile
 * differences are returned so a reader can see *that* the run was live rather
 * than a copy, which is the part a plain `git diff` cannot tell you.
 */
export function compareRunRecords(committed: RunRecord, fresh: RunRecord): RunComparison {
  const invariantMismatches = diffTier(invariantTier(committed), invariantTier(fresh));
  const volatileChanged = diffTier(volatileTier(committed), volatileTier(fresh));
  return { ok: invariantMismatches.length === 0, invariantMismatches, volatileChanged };
}

// ── provenance ─────────────────────────────────────────────────────────────

function gitHead(): string | null {
  const out = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = out.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * The commit a run was made from.
 *
 * Precedence is `PHASE3_GIT_SHA`, then `GIT_SHA` (injection: CI and packaging
 * know their own sha and may run outside a checkout), then `git rev-parse HEAD`,
 * then `null`. Never throws — a missing sha makes the record less precise, which
 * is a far better outcome than a proof run that refuses to finish because the
 * directory is not a repository.
 */
export function resolveGitSha(
  env: Record<string, string | undefined>,
  readHead: () => string | null = gitHead,
): string | null {
  for (const name of ["PHASE3_GIT_SHA", "GIT_SHA"]) {
    const injected = env[name];
    if (typeof injected === "string" && injected.trim().length > 0) return injected.trim();
  }
  try {
    return readHead();
  } catch {
    return null;
  }
}

/** Convenience wrapper around `resolveGitSha` over the real environment. */
export function currentGitSha(): string | null {
  return resolveGitSha(process.env);
}
