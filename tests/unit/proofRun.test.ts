import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RUN_RECORD_SCHEMA_VERSION,
  buildRunRecord,
  canonicalize,
  collectTxHashes,
  compareRunRecords,
  deriveAssertions,
  resolveGitSha,
  serializeRunRecord,
  type ProofFacts,
  type RunRecord,
} from "../../lib/guard/proofRun.ts";

/**
 * The emit shape and the two-tier diff rule, tested against the real committed
 * proof rather than against invented facts.
 *
 * The point of the run record is that someone can re-run the proof and diff the
 * result against the committed copy. These tests pin the half of that which is
 * verifiable without testnet access: the shape, the assertion names, and the
 * rule that separates "this run is still the same proof" from "this run touched
 * new ledgers". What cannot be verified here — that the chain still answers, and
 * that a live `--emit` run reproduces these names — needs a funded testnet run
 * and is stated as such in tests/fixtures/README.md.
 */

/**
 * The assertion names, in order. This list is the contract: it is the invariant
 * half of the record, so an addition or a rename is a deliberate change that a
 * diff against a committed run record will surface, rather than silent drift.
 */
const ASSERTION_NAMES = [
  "artifact.pin-matches-chain",
  "contract-presence.guard-and-token",
  "deploy.runs-pinned-artifact",
  "initialize.landed",
  "policy.installed-via-console-form-path",
  "token.guard-funded",
  "transfer.allowed-while-unfrozen",
  "freeze.landed",
  "freeze.status-reread-reports-admin-frozen",
  "freeze.check-view-blocked",
  "transfer.blocked-while-frozen",
  "transfer.blocked-with-reason-admin-frozen",
  "unfreeze.landed",
  "unfreeze.status-reread-reports-admin-unfrozen",
  "transfer.allowed-after-unfreeze",
  "telemetry.decoded-lifecycle-events",
  "telemetry.lifecycle-complete-in-scan-window",
];

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const PROOF = fixture("phase3-proof.json") as ProofFacts;

/** A second run over the same pipeline, with every volatile fact replaced. */
function rerunFacts(base: ProofFacts): ProofFacts {
  const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  // A fresh deployment: new salt, new accounts, new ledgers, new hashes.
  clone["guard"] = `C${"A".repeat(55)}`;
  clone["token"] = `C${"B".repeat(55)}`;
  for (const [index, step] of [
    "tokenCreate",
    "deploy",
    "initialize",
    "setPolicy",
    "trustline",
    "mint",
    "freeze",
    "unfreeze",
  ].entries()) {
    const value = clone[step];
    if (typeof value === "object" && value !== null && "hash" in value) {
      const copy = { ...(value as Record<string, unknown>) };
      copy["hash"] = String(index).repeat(64);
      copy["ledger"] = 5_000_000 + index;
      clone[step] = copy;
    }
  }
  for (const step of ["transferWhileUnfrozen", "transferAfterUnfreeze"]) {
    const value = clone[step];
    if (typeof value === "object" && value !== null && "hash" in value) {
      const copy = { ...(value as Record<string, unknown>) };
      copy["hash"] = "9".repeat(64);
      copy["ledger"] = 5_000_100;
      clone[step] = copy;
    }
  }
  const afterFreeze = clone["statusAfterFreeze"];
  if (typeof afterFreeze === "object" && afterFreeze !== null) {
    clone["statusAfterFreeze"] = { ...(afterFreeze as object), now: "1999999999" };
  }
  return clone as ProofFacts;
}

function run(
  facts: ProofFacts,
  runDate: string,
  gitSha: string | null = `sha-for-${runDate}`,
): RunRecord {
  return buildRunRecord({
    runDate,
    gitSha,
    outcome: "passed",
    facts,
    note: "test",
  });
}

// ── shape ───────────────────────────────────────────────────────────────────

test("the emit shape is machine-parseable and carries every required field", () => {
  const record = run(PROOF, "2026-09-16T11:52:10.153Z");

  // Round-trip through JSON, because the whole point of the record is that
  // something else (the diff tool, a reviewer) can parse it without running
  // the proof again.
  const parsed: unknown = JSON.parse(JSON.stringify(record));
  assert.deepEqual(parsed, canonicalize(record));
  assert.equal(JSON.parse(JSON.stringify(record)).schemaVersion, RUN_RECORD_SCHEMA_VERSION);

  const shape = record as unknown as Record<string, unknown>;
  for (const field of [
    "runDate",
    "gitSha",
    "outcome",
    "error",
    "contractIds",
    "txHashes",
    "assertions",
    "note",
  ]) {
    assert.ok(field in shape, `run record must carry ${field}`);
  }
  assert.equal(shape["runDate"], "2026-09-16T11:52:10.153Z");
  assert.equal(shape["outcome"], "passed");
  assert.equal(shape["error"], null);
  assert.equal(typeof shape["contractIds"], "object");
  assert.equal(typeof shape["txHashes"], "object");
  assert.ok(Array.isArray(shape["assertions"]));
});

test("bigint facts in the live record stringify instead of throwing", () => {
  // The proof script holds bigints (ledger timestamps) in its record object
  // before it serialises. The emit path must not be the one place that throws
  // on a value the record legitimately holds.
  const facts: ProofFacts = {
    ...PROOF,
    statusAfterFreeze: {
      admin_frozen: true,
      has_policy: true,
      last_heartbeat: 1_789_559_582n,
      now: 1_789_559_612n,
    },
  };
  const record = run(facts, "2026-09-16T11:52:10.153Z");
  // Plain JSON.stringify throws on a bigint, which is why the record owns its
  // serialisation rather than delegating it to each caller's replacer.
  assert.throws(() => JSON.stringify(record), /BigInt/);
  assert.doesNotThrow(() => serializeRunRecord(record));

  const row = record.assertions.find((a) => a.name === "freeze.status-reread-reports-admin-frozen");
  assert.ok(row);
  // Ledger timestamps come back as decimal strings, which is what the committed
  // proof already carries — the emit path must not be the one that changes them.
  assert.deepEqual(JSON.parse(serializeRunRecord(record)).assertions.length, 17);
  const roundTripped = JSON.parse(serializeRunRecord(record)) as RunRecord;
  const roundTrippedRow = roundTripped.assertions.find(
    (a) => a.name === "freeze.status-reread-reports-admin-frozen",
  );
  assert.deepEqual(roundTrippedRow?.actual, {
    admin_frozen: true,
    last_heartbeat: "1789559582",
    now: "1789559612",
  });
  assert.equal(row.pass, true);
});

test("txHashes carries one entry per step that actually broadcast", () => {
  const hashes = collectTxHashes(PROOF);
  // The deploy plan is several submissions nested under `deploy.steps[]`, and the
  // deploy is the headline transaction of the whole proof, so it must not be the
  // one step that goes missing from the record.
  assert.equal(typeof hashes["deploy"], "string");
  assert.equal(typeof hashes["tokenCreate"], "string");
  assert.equal(typeof hashes["freeze"], "string");
  assert.equal(typeof hashes["unfreeze"], "string");
  assert.equal(typeof hashes["transferWhileUnfrozen"], "string");
  // The refused transfer never broadcast, so there is deliberately no key for
  // it — demanding one would be demanding fabricated evidence.
  assert.equal("transferWhileFrozen" in hashes, false);
  // Every value is a 64-hex-char transaction hash.
  for (const [step, hash] of Object.entries(hashes)) {
    assert.match(hash, /^[0-9a-f]{64}$/, `${step} should be a transaction hash`);
  }
});

test("a reused step contributes no hash rather than a placeholder", () => {
  const reusedFacts: ProofFacts = { ...PROOF, deploy: { guard: "CABC", reused: true } };
  const hashes = collectTxHashes(reusedFacts);
  assert.equal("deploy" in hashes, false);
});

// ── assertions ──────────────────────────────────────────────────────────────

test("the assertion set is exactly the documented list, in order", () => {
  assert.deepEqual(
    deriveAssertions(PROOF).map((assertion) => assertion.name),
    ASSERTION_NAMES,
  );
});

test("every assertion in the committed proof passes and reports a value", () => {
  const assertions = deriveAssertions(PROOF);
  const failing = assertions.filter((assertion) => !assertion.pass).map((a) => a.name);
  assert.deepEqual(failing, [], `committed proof should satisfy every assertion: ${failing}`);
  // `actual` is what makes a failing row diagnosable, so it is never dropped —
  // `telemetry.lifecycle-complete-in-scan-window` legitimately records [] here.
  for (const assertion of assertions) {
    assert.ok("actual" in assertion, `${assertion.name} must record what it observed`);
  }
});

test("degenerate facts produce failing assertions rather than a throw", () => {
  // A record from a run that died early must still be describable, which is
  // what makes `--emit` useful on failure at all.
  const assertions = deriveAssertions({});
  assert.equal(assertions.length, ASSERTION_NAMES.length);
  assert.equal(
    assertions.every((assertion) => assertion.pass === false),
    true,
  );
});

test("the reuse-aware steps treat reuse as satisfied, not as a failure", () => {
  // Reuse is what makes the script idempotent, so a second run over an existing
  // deployment must not fail these rows.
  const reused: ProofFacts = {
    ...PROOF,
    deploy: { guard: "CABC", reused: true },
    initialize: { reused: true },
  };
  const assertions = deriveAssertions(reused);
  const byName = new Map(assertions.map((assertion) => [assertion.name, assertion.pass]));
  assert.equal(byName.get("deploy.runs-pinned-artifact"), true);
  assert.equal(byName.get("initialize.landed"), true);
});

test("a frozen account that allowed a transfer is reported as failing", () => {
  const broken: ProofFacts = { ...PROOF, transferWhileFrozen: { kind: "allowed" } };
  const assertions = deriveAssertions(broken);
  const byName = new Map(assertions.map((assertion) => [assertion.name, assertion.pass]));
  assert.equal(byName.get("transfer.blocked-while-frozen"), false);
  assert.equal(byName.get("transfer.blocked-with-reason-admin-frozen"), false);
});

test("a gap in the telemetry scan window is reported, not hidden", () => {
  const gapped: ProofFacts = { ...PROOF, telemetryMissingFromScan: ["unfrozen"] };
  const assertions = deriveAssertions(gapped);
  const row = assertions.find((a) => a.name === "telemetry.lifecycle-complete-in-scan-window");
  assert.equal(row?.pass, false);
  assert.deepEqual(row?.actual, ["unfrozen"]);
});

// ── the two-tier diff ───────────────────────────────────────────────────────

test("a re-run matches the committed record while every volatile field churns", () => {
  // The required case: identical behaviour, brand-new deployment. The invariant
  // tier must match and the volatile tier must not.
  const committed = run(PROOF, "2026-09-16T11:52:10.153Z");
  const fresh = run(rerunFacts(PROOF), "2026-10-02T08:00:00.000Z");

  const comparison = compareRunRecords(committed, fresh);
  assert.deepEqual(comparison.invariantMismatches, []);
  assert.equal(comparison.ok, true);

  const changed = comparison.volatileChanged.map((difference) => difference.field);
  for (const field of ["runDate", "gitSha", "contractIds", "txHashes", "assertionActuals"]) {
    assert.ok(changed.includes(field), `expected ${field} to churn on a re-run`);
  }
});

test("comparing a record with itself is a match with zero churn", () => {
  const committed = run(PROOF, "2026-09-16T11:52:10.153Z");
  const comparison = compareRunRecords(committed, committed);
  assert.equal(comparison.ok, true);
  assert.deepEqual(comparison.invariantMismatches, []);
  assert.deepEqual(comparison.volatileChanged, []);
});

test("a renamed assertion is an invariant mismatch, not volatile churn", () => {
  const committed = run(PROOF, "2026-09-16T11:52:10.153Z");
  const fresh = run(rerunFacts(PROOF), "2026-10-02T08:00:00.000Z");
  const target = fresh.assertions[ASSERTION_NAMES.indexOf("freeze.landed")!];
  assert.ok(target);
  target.name = "freeze.submitted";

  const comparison = compareRunRecords(committed, fresh);
  assert.equal(comparison.ok, false);
  assert.deepEqual(
    comparison.invariantMismatches.map((difference) => difference.field),
    ["assertionNames"],
  );
});

test("a flipped assertion outcome is an invariant mismatch", () => {
  const committed = run(PROOF, "2026-09-16T11:52:10.153Z");
  const fresh = run(rerunFacts(PROOF), "2026-10-02T08:00:00.000Z");
  const target = fresh.assertions.find(
    (a) => a.name === "transfer.blocked-with-reason-admin-frozen",
  );
  assert.ok(target);
  target.pass = false;

  const comparison = compareRunRecords(committed, fresh);
  assert.equal(comparison.ok, false);
  assert.deepEqual(
    comparison.invariantMismatches.map((difference) => difference.field),
    ["assertionResults"],
  );
});

test("a missing contract id is an invariant mismatch", () => {
  const committed = run(PROOF, "2026-09-16T11:52:10.153Z");
  const facts = rerunFacts(PROOF);
  delete (facts as Record<string, unknown>)["guard"];
  const fresh = run(facts, "2026-10-02T08:00:00.000Z");

  const comparison = compareRunRecords(committed, fresh);
  assert.equal(comparison.ok, false);
  // Losing the guard id trips both the presence check and the assertion that
  // reads it — which is the point of asserting the same fact twice at two tiers.
  assert.deepEqual(comparison.invariantMismatches.map((difference) => difference.field).sort(), [
    "assertionResults",
    "contractPresence",
  ]);
});

test("a failed run cannot pass as a re-run of a passing one", () => {
  const committed = run(PROOF, "2026-09-16T11:52:10.153Z");
  const fresh = buildRunRecord({
    runDate: "2026-10-02T08:00:00.000Z",
    gitSha: null,
    outcome: "failed",
    error: "timed out waiting for abc123",
    facts: {},
    note: "test",
  });

  const comparison = compareRunRecords(committed, fresh);
  assert.equal(comparison.ok, false);
  const fields = comparison.invariantMismatches.map((difference) => difference.field);
  assert.ok(fields.includes("outcome"));
  assert.ok(fields.includes("contractPresence"));
});

test("the canonical form ignores key order but not values", () => {
  // A mismatch report is read by a human; key order must not manufacture one.
  assert.deepEqual(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.notDeepEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
  assert.equal(canonicalize(7n), "7");
  // Nested objects are canonicalised too, not just the top level.
  assert.deepEqual(canonicalize({ x: { b: 1, a: 2 } }), { x: { a: 2, b: 1 } });
});

// ── provenance ──────────────────────────────────────────────────────────────

test("an injected sha wins over shelling out to git", () => {
  let shelled = false;
  const sha = resolveGitSha({ PHASE3_GIT_SHA: " injected-sha " }, () => {
    shelled = true;
    return "from-git";
  });
  assert.equal(sha, "injected-sha");
  assert.equal(shelled, false);
});

test("GIT_SHA is honoured when the script-specific variable is absent", () => {
  assert.equal(
    resolveGitSha({ GIT_SHA: "from-ci" }, () => "from-git"),
    "from-ci",
  );
});

test("a missing or broken git checkout yields null instead of throwing", () => {
  // A proof run that refuses to finish because it is not in a repository would
  // be worse than a record with a less precise provenance field.
  assert.equal(
    resolveGitSha({}, () => "from-git"),
    "from-git",
  );
  assert.equal(
    resolveGitSha({}, () => {
      throw new Error("not a git repository");
    }),
    null,
  );
  assert.equal(
    resolveGitSha({ PHASE3_GIT_SHA: "   " }, () => "from-git"),
    "from-git",
  );
});

// ── the committed run record ────────────────────────────────────────────────

test("the committed run record is a valid record of the committed proof", () => {
  const committed = fixture("phase3-proof.run.json") as RunRecord;
  assert.equal(committed.schemaVersion, RUN_RECORD_SCHEMA_VERSION);
  assert.ok(Array.isArray(committed.assertions));
  assert.deepEqual(
    committed.assertions.map((assertion) => assertion.name),
    ASSERTION_NAMES,
  );
  assert.deepEqual(
    committed.assertions.filter((assertion) => !assertion.pass),
    [],
  );

  // It must be the projection of the committed proof, not a hand-written file
  // that merely looks like one — otherwise the two records could disagree.
  const projected = run(PROOF, committed.runDate, committed.gitSha);
  const comparison = compareRunRecords(projected, committed);
  assert.deepEqual(
    comparison.invariantMismatches,
    [],
    "the committed run record and the committed proof must agree on the invariant tier",
  );
  assert.deepEqual(
    comparison.volatileChanged.map((difference) => difference.field),
    [],
    "the committed run record must be a faithful projection, not an approximation",
  );
});
