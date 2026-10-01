import test from "node:test";
import assert from "node:assert/strict";
import { POLLING, jitteredInterval } from "../../lib/guard/polling.ts";

test("POLLING config", async (t) => {
  await t.test("defaults preserve the pre-centralization values exactly", () => {
    // Behavior-preservation proof: each entry is the value that used to sit
    // inline at its call site (GuardProvider snapshot/feed/demo, FleetTable,
    // submit.ts's inclusion poll).
    assert.equal(POLLING.snapshotMs, 15_000);
    assert.equal(POLLING.feedMs, 5_000);
    assert.equal(POLLING.fleetMs, 5_000);
    assert.equal(POLLING.demoEventMs, 4_000);
    assert.equal(POLLING.txInclusionMs, 2_000);
    assert.equal(POLLING.txInclusionAttempts, 30);
  });

  await t.test("every configured interval is a positive integer", () => {
    for (const value of Object.values(POLLING)) {
      assert.ok(Number.isInteger(value), `expected integer, got ${value}`);
      assert.ok(value > 0, `expected positive value, got ${value}`);
    }
  });
});

test("jitteredInterval", async (t) => {
  await t.test("keeps the result within [0.8·I, I) across many draws", () => {
    let rngCalls = 0;
    const rng = () => {
      rngCalls += 1;
      // Sweep the unit interval deterministically instead of trusting chance.
      return (rngCalls % 101) / 100.999;
    };
    for (let i = 0; i < 500; i++) {
      const jittered = jitteredInterval(10_000, "full", rng);
      assert.ok(jittered >= 8_000, `below floor: ${jittered}`);
      assert.ok(jittered < 10_000, `at or above ceiling: ${jittered}`);
      assert.ok(Number.isInteger(jittered), `non-integer: ${jittered}`);
    }
  });

  await t.test("pinning the rng produces the expected delay", () => {
    // rng() === 0 → factor 0.8 (floor); rng() === 0.5 → factor 0.9.
    assert.equal(
      jitteredInterval(10_000, "full", () => 0),
      8_000,
    );
    assert.equal(
      jitteredInterval(10_000, "full", () => 0.5),
      9_000,
    );
    assert.equal(
      jitteredInterval(5_000, "full", () => 0.25),
      4_250,
    );
  });

  await t.test("spreads consecutive pollers across the jitter band", () => {
    let n = 0;
    const rng = () => {
      n += 1;
      return (n * 0.13) % 1;
    };
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) delays.add(jitteredInterval(10_000, "full", rng));
    // A spread of distinct cadences is the whole point: uniform timers all
    // collapse to one value.
    assert.ok(delays.size > 5, `expected spread, got ${delays.size} distinct values`);
  });

  await t.test("'none' mode returns the interval unchanged (deterministic)", () => {
    assert.equal(jitteredInterval(10_000, "none"), 10_000);
    assert.equal(jitteredInterval(5_000, "none"), 5_000);
    assert.equal(
      jitteredInterval(10_000, "none", () => 0.99),
      10_000,
    );
  });

  await t.test("defaults to full jitter with the platform rng", () => {
    const value = jitteredInterval(10_000);
    assert.ok(value >= 8_000 && value < 10_000);
  });
});
