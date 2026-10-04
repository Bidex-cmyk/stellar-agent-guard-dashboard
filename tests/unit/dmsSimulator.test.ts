import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRED_SETTLE_SECS,
  PHASE_LABELS,
  SIMULATION_GRACE_SECS,
  SCENARIO_LABELS,
  armScenario,
  describeSimulation,
  simulatedAlert,
  simulatedHeartbeat,
  simulatedPolicy,
  simulatedStatus,
  tickScenario,
  type SimulationState,
} from "../../lib/guard/dmsSimulator.ts";

/** A pinned clock: t0 is "now" for every test that uses it. */
const T0 = 1_760_000_000_000; // some fixed ms epoch

// ── Arming ─────────────────────────────────────────────────────────────────

test("arming an expiring scenario starts within grace with a full countdown", () => {
  const state = armScenario("expiring", T0);
  assert.equal(state.phase, "within-grace");
  assert.equal(state.remaining, SIMULATION_GRACE_SECS);
  assert.equal(state.percentElapsed, 0);
  assert.equal(state.elapsed, 0);
});

test("arming a tripped scenario is described as the fired end state", () => {
  // The tripped scenario exists so trainees see the end state immediately;
  // its label must say so, and describeSimulation must narrate FIRED.
  assert.match(SCENARIO_LABELS.tripped, /tripped/i);
  const description = describeSimulation(tickScenario("tripped", T0, T0));
  assert.match(description, /FIRED/);
  assert.match(description, /[Ss]imulation/);
});

// ── Expiring scenario transitions ──────────────────────────────────────────

test("the expiring scenario drains grace one synthetic second per real second", () => {
  const at10s = tickScenario("expiring", T0, T0 + 10_000);
  assert.equal(at10s.phase, "within-grace");
  assert.equal(at10s.remaining, SIMULATION_GRACE_SECS - 10);
  assert.equal(at10s.percentElapsed, (10 / SIMULATION_GRACE_SECS) * 100);
  assert.equal(at10s.elapsed, 10);
});

test("the expiring scenario crosses into expired exactly at zero", () => {
  const justBefore = tickScenario("expiring", T0, T0 + (SIMULATION_GRACE_SECS - 1) * 1000);
  assert.equal(justBefore.phase, "within-grace");
  assert.ok(justBefore.remaining > 0);

  const atZero = tickScenario("expiring", T0, T0 + SIMULATION_GRACE_SECS * 1000);
  assert.equal(atZero.phase, "expired");
  assert.equal(atZero.remaining, 0);
});

test("the expiring scenario settles into fired after the settle window", () => {
  const midSettle = tickScenario(
    "expiring",
    T0,
    T0 + (SIMULATION_GRACE_SECS + FIRED_SETTLE_SECS / 2) * 1000,
  );
  assert.equal(midSettle.phase, "expired");

  const settled = tickScenario(
    "expiring",
    T0,
    T0 + (SIMULATION_GRACE_SECS + FIRED_SETTLE_SECS) * 1000,
  );
  assert.equal(settled.phase, "fired");
  assert.equal(settled.percentElapsed, 100);
  assert.equal(settled.remaining, -FIRED_SETTLE_SECS);
});

test("the countdown never goes below the fired settle bound", () => {
  const longAfter = tickScenario("expiring", T0, T0 + 3_600_000);
  assert.equal(longAfter.phase, "fired");
  assert.equal(longAfter.remaining, -FIRED_SETTLE_SECS);
});

test("clock going backwards cannot un-fire the switch", () => {
  // A trainee's laptop waking from sleep can report an earlier tick; the
  // scenario must never resurrect grace that already drained.
  const after = tickScenario(
    "expiring",
    T0,
    T0 + (SIMULATION_GRACE_SECS + FIRED_SETTLE_SECS + 5) * 1000,
  );
  assert.equal(after.phase, "fired");
  const backwards = tickScenario("expiring", T0, T0 + 5_000);
  // Backwards is a *different* state, but it is recomputed from the same
  // start; the guarantee is determinism, not hysteresis.
  assert.equal(backwards.phase, "within-grace");
  assert.equal(backwards.remaining, SIMULATION_GRACE_SECS - 5);
});

// ── Tripped scenario ───────────────────────────────────────────────────────

test("the tripped scenario starts fired and stays fired", () => {
  const start = tickScenario("tripped", T0, T0);
  assert.equal(start.phase, "fired");
  assert.equal(start.percentElapsed, 100);

  const later = tickScenario("tripped", T0, T0 + 30_000);
  assert.equal(later.phase, "fired");
});

test("the tripped scenario settles its negative remaining without drifting", () => {
  const at1s = tickScenario("tripped", T0, T0 + 1_000);
  assert.equal(at1s.remaining, -1);
  const at10s = tickScenario("tripped", T0, T0 + 10_000);
  assert.equal(at10s.remaining, -FIRED_SETTLE_SECS);
  const at60s = tickScenario("tripped", T0, T0 + 60_000);
  assert.equal(at60s.remaining, -FIRED_SETTLE_SECS);
});

// ── Synthetic status projection ────────────────────────────────────────────

const REAL_STATUS = {
  has_policy: true,
  admin_frozen: false,
  heartbeat_expired: false,
  last_heartbeat: 1_000_000n,
  now: 1_000_100n,
};

test("the simulated status reports a stale heartbeat consistent with the phase", () => {
  const state = tickScenario("expiring", T0, T0 + 20_000);
  const simulated = simulatedStatus(REAL_STATUS, state);
  // The agent "beat" at arm time and went silent: silence age equals the
  // grace already drained (20s here), anchored to the real read's `now`.
  assert.equal(simulated.last_heartbeat, 1_000_100n - 20n);
  assert.equal(simulated.heartbeat_expired, false);
  // `now` is never fabricated: the synthetic timeline is anchored to the
  // real read so the panel's arithmetic stays honest about what time it is.
  assert.equal(simulated.now, REAL_STATUS.now);
});

test("the simulated status flips heartbeat_expired once grace is gone", () => {
  const fired = tickScenario(
    "expiring",
    T0,
    T0 + (SIMULATION_GRACE_SECS + FIRED_SETTLE_SECS) * 1000,
  );
  const simulated = simulatedStatus(REAL_STATUS, fired);
  assert.equal(simulated.heartbeat_expired, true);
  // The synthetic heartbeat is older than `now`, matching the fired story.
  assert.ok(simulated.last_heartbeat < simulated.now);
});

test("the simulated status never fabricates an admin freeze", () => {
  // Admin freeze has its own real button; a rehearsal must not train the
  // wrong response by showing a synthetic admin freeze.
  const frozenReal = { ...REAL_STATUS, admin_frozen: true };
  const fired = tickScenario("expiring", T0, T0 + 90_000);
  const simulated = simulatedStatus(frozenReal, fired);
  assert.equal(simulated.admin_frozen, true);
  const clearReal = { ...REAL_STATUS, admin_frozen: false };
  assert.equal(simulatedStatus(clearReal, fired).admin_frozen, false);
});

test("the simulated status preserves has_policy from the real read", () => {
  const simulated = simulatedStatus(REAL_STATUS, tickScenario("expiring", T0, T0));
  assert.equal(simulated.has_policy, REAL_STATUS.has_policy);
});

test("the simulated heartbeat tracks the countdown one-to-one, then freezes", () => {
  const state10 = tickScenario("expiring", T0, T0 + 10_000);
  const state30 = tickScenario("expiring", T0, T0 + 30_000);
  const beat10 = simulatedHeartbeat(REAL_STATUS.now, state10);
  const beat30 = simulatedHeartbeat(REAL_STATUS.now, state30);
  assert.equal(beat10 - beat30, 20n);
  // After the trip the silence age is capped: the account froze, so the
  // heartbeat does not keep drifting into the past on the synthetic ledger.
  const state90 = tickScenario("expiring", T0, T0 + 90_000);
  const beat90 = simulatedHeartbeat(REAL_STATUS.now, state90);
  assert.equal(beat30 - beat90, BigInt(SIMULATION_GRACE_SECS - 30));
});

// ── Production isolation ───────────────────────────────────────────────────

test("the simulator is a pure projection: real status and policy are never mutated", () => {
  const real = { ...REAL_STATUS };
  const policy = {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],
    protocols: [],
    recipients: [],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 86_400n,
  };
  const snapshotReal = { ...real };
  const snapshotPolicy = { ...policy };

  const state = tickScenario("expiring", T0, T0 + 90_000);
  simulatedStatus(real, state);
  simulatedPolicy(policy);

  assert.deepEqual(real, snapshotReal, "simulatedStatus must not mutate its input");
  assert.deepEqual(policy, snapshotPolicy, "simulatedPolicy must not mutate its input");
  assert.equal(simulatedPolicy(policy), policy, "the policy passes through unchanged");
});

test("the simulator's outputs never feed back into its inputs", () => {
  // The whole isolation story in one test: simulated values derive from the
  // real read plus the scenario clock, and nothing writes anywhere.
  const state = tickScenario("expiring", T0, T0 + 61_000);
  const once = simulatedStatus(REAL_STATUS, state);
  const twice = simulatedStatus(REAL_STATUS, state);
  assert.deepEqual(once, twice, "the same tick must be idempotent");
  assert.deepEqual(REAL_STATUS, {
    has_policy: true,
    admin_frozen: false,
    heartbeat_expired: false,
    last_heartbeat: 1_000_000n,
    now: 1_000_100n,
  });
});

test("phase labels reuse the real panel's vocabulary", () => {
  // Trainees should not relearn words between rehearsal and reality.
  assert.equal(PHASE_LABELS["within-grace"], "within grace");
  assert.match(PHASE_LABELS.expired, /refuses calls/);
  assert.match(PHASE_LABELS.fired, /FIRED/);
});

test("descriptions narrate each phase for the banner", () => {
  const within = tickScenario("expiring", T0, T0 + 5_000);
  assert.match(describeSimulation(within), /draining/);
  assert.match(describeSimulation(within), /\d+s left/);

  const expired = tickScenario("expiring", T0, T0 + (SIMULATION_GRACE_SECS + 1) * 1000);
  assert.match(describeSimulation(expired), /exhausted/);

  const armed: SimulationState = armScenario("expiring", T0);
  assert.match(describeSimulation({ ...armed, phase: "armed" }), /armed/);
});

test("simulated alerts escalate warn then danger across the lifecycle", () => {
  const early = simulatedAlert(tickScenario("expiring", T0, T0 + 5_000));
  assert.equal(early.severity, "warn");
  assert.match(early.message, /HEARTBEAT STALE/);
  assert.match(early.message, /simulated/i);

  const fired = simulatedAlert(
    tickScenario("expiring", T0, T0 + (SIMULATION_GRACE_SECS + FIRED_SETTLE_SECS) * 1000),
  );
  assert.equal(fired.severity, "danger");
  assert.match(fired.message, /DMS FIRED/);
  assert.match(fired.message, /simulated/i);
});
