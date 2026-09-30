import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  DEFAULT_JITTER_FRACTION,
  DEFAULT_POLL_CADENCE,
  computePollDelay,
  startPollingLoop,
} from "../../lib/guard/polling.ts";

afterEach(() => {
  mock.timers.reset();
});

// ── The config itself ───────────────────────────────────────────────────────
//
// Issue #56's preservation proof, as a table: each cadence key equals the
// interval the code polled at before centralization. The old literals are
// quoted here deliberately — if someone retunes a cadence, this row fails and
// forces the change to be argued, not slipped in.

test("cadence defaults preserve every pre-centralization interval exactly", () => {
  // GuardProvider.tsx: `const SNAPSHOT_INTERVAL_MS = 15_000;`
  assert.equal(DEFAULT_POLL_CADENCE.statusMs, 15_000, "statusMs: the snapshot poll's old 15s");
  // GuardProvider.tsx: `const FEED_INTERVAL_MS = 5_000;`
  assert.equal(DEFAULT_POLL_CADENCE.feedMs, 5_000, "feedMs: the telemetry feed's old 5s");
  // FleetTable.tsx: `setInterval(fetchFleet, 5000)`
  assert.equal(DEFAULT_POLL_CADENCE.fleetMs, 5_000, "fleetMs: the fleet table's old 5s");
  // Same loop as status (SPEC.md §8: balance is read by the snapshot poll);
  // the key names the concern, it does not add a timer.
  assert.equal(DEFAULT_POLL_CADENCE.balanceMs, DEFAULT_POLL_CADENCE.statusMs, "balanceMs shares the snapshot loop");
});

test("the jitter fraction matches the SDK's documented default", () => {
  // stellar-agent-guard-sdk src/telemetry.ts: `DEFAULT_JITTER_FRACTION = 0.2`
  assert.equal(DEFAULT_JITTER_FRACTION, 0.2);
});

// ── computePollDelay (the SDK's formula) ────────────────────────────────────

test("default jitter is full: delays stay inside [0.8I, I] across many draws", () => {
  for (let i = 0; i < 500; i += 1) {
    const delay = computePollDelay(5_000);
    assert.ok(delay >= 4_000, `delay ${delay} must be >= 0.8 * 5000`);
    assert.ok(delay <= 5_000, `delay ${delay} must be <= 5000`);
    assert.ok(Number.isInteger(delay), `delay ${delay} must be an integer (Math.round)`);
  }
});

test("an injected rng drives the delay deterministically through the full-jitter window", () => {
  // rng()=0 → the bottom of the window: 5000 * (1 - 0.2 + 0) = 4000.
  assert.equal(computePollDelay(5_000, "full", () => 0), 4_000);
  // rng()=1 → the top of the window: the full interval.
  assert.equal(computePollDelay(5_000, "full", () => 1), 5_000);
  // rng()=0.5 → the midpoint: 5000 * 0.9 = 4500.
  assert.equal(computePollDelay(5_000, "full", () => 0.5), 4_500);
});

test("jitter 'none' is deterministic regardless of the rng", () => {
  assert.equal(computePollDelay(5_000, "none", () => 0), 5_000);
  assert.equal(computePollDelay(5_000, "none", () => 1), 5_000);
  assert.equal(computePollDelay(5_000, "none", () => 0.999), 5_000);
});

// ── Negative tests: bad inputs fail loudly, not weirdly ────────────────────

test("a negative interval produces a negative delay rather than a silently valid one", () => {
  // The function is arithmetic, not a validator (the config's callers pass
  // constants), but it must not launder a nonsensical input into a
  // plausible-looking number: the negative interval must survive visibly.
  const delay = computePollDelay(-1_000, "none");
  assert.equal(delay, -1_000);
  assert.ok(delay < 0, "a negative interval must not come back positive");
});

test("a NaN interval poisons the delay rather than being quietly coerced", () => {
  assert.ok(Number.isNaN(computePollDelay(Number.NaN, "none")), "NaN in, NaN out — no silent default");
});

test("an out-of-range jitter fraction is clamped into [0, 1], never a runaway window", () => {
  // j=5 would otherwise give a window of [-4I, I]; clamped to j=1 → [0, I].
  const lo = computePollDelay(5_000, "full", () => 0, 5);
  assert.ok(lo >= 0, `clamped-low delay ${lo} must not go negative`);
  assert.ok(lo <= 5_000, `clamped-low delay ${lo} must stay within the interval`);
  // j=-1 would invert the window to [1.2I, I]; clamped to j=0 → exactly I.
  assert.equal(computePollDelay(5_000, "full", () => 0, -1), 5_000);
});

// ── startPollingLoop ────────────────────────────────────────────────────────

test("the loop ticks at the jittered first delay and keeps jittering each round", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const draws: number[] = [];
  let ticks = 0;
  const rng = () => {
    draws.push(0.5); // every draw → 5000 * 0.9 = 4500
    return 0.5;
  };
  const stop = startPollingLoop(5_000, () => {
    ticks += 1;
  }, "full", rng);
  try {
    mock.timers.tick(4_499);
    assert.equal(ticks, 0, "not yet: the first (jittered) delay has not elapsed");
    mock.timers.tick(1);
    assert.equal(ticks, 1, "the first tick lands on the jittered delay, not the bare interval");
    // The second round draws a fresh delay: another 4500ms.
    mock.timers.tick(4_500);
    assert.equal(ticks, 2, "each round re-jitters from a fresh draw");
    // One draw per round *scheduled*: round N+1's delay is drawn the moment
    // round N's tick returns, so 2 ticks mean 3 draws (round 3 is already set).
    assert.equal(draws.length, 3, "one fresh draw per scheduled round");
  } finally {
    stop();
  }
});

test("stop() prevents any further ticks, even mid-delay", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let ticks = 0;
  const stop = startPollingLoop(5_000, () => {
    ticks += 1;
  }, "none");
  mock.timers.tick(5_000);
  assert.equal(ticks, 1);
  stop();
  mock.timers.tick(60_000);
  assert.equal(ticks, 1, "no tick fires after stop");
});

test("the next round is scheduled only after the previous tick returns", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const events: string[] = [];
  const stop = startPollingLoop(5_000, () => {
    events.push("tick");
    // A tick that is still running when the next round would nominally be due:
    // the loop must not schedule it before this callback returns.
    setTimeout(() => events.push("tick-cleanup"), 3_000);
  }, "none");
  try {
    mock.timers.tick(5_000); // tick 1 fires; its cleanup timer is now pending
    mock.timers.tick(2_000); // past 2/5 of the interval, still inside tick 1's cleanup window
    assert.deepEqual(events, ["tick"], "no second round before the interval — and none scheduled from inside the running tick");
    mock.timers.tick(1_000); // cleanup fires (tick-cleanup), tick 1 has now fully returned
    mock.timers.tick(2_000); // 5000ms since round 1 was scheduled
    assert.equal(events.filter((e) => e === "tick").length, 2, "round 2 lands on schedule after round 1 returned");
    assert.ok(events.indexOf("tick-cleanup") < events.lastIndexOf("tick"), "round 1's cleanup precedes round 2");
  } finally {
    stop();
  }
});
