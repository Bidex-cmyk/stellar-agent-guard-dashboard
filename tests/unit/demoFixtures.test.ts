import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEMO_BADGE_TEXT,
  DEMO_BASE_LEDGER,
  DEMO_GUARD,
  DEMO_INSTANCE,
  demoEvents,
  demoFlagFromEnv,
  demoFlagFromQuery,
  demoSnapshot,
  isDemoMode,
  syntheticDemoEvent,
} from "../../lib/guard/demoFixtures.ts";
import { looksLikeContractAddress } from "../../lib/guard/instance.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";

/** A fixed clock, so the derived timestamps in the fixture are pinned. */
const NOW = 1_700_000_000_000;

describe("demo flag parsing", () => {
  it("treats the affirmative environment values as on", () => {
    assert.equal(demoFlagFromEnv("true"), true);
    assert.equal(demoFlagFromEnv("1"), true);
  });

  it("treats anything else in the environment as off", () => {
    for (const value of [undefined, "", "false", "0", "yes", "TRUE", "true "]) {
      assert.equal(demoFlagFromEnv(value), false, `expected ${JSON.stringify(value)} to be off`);
    }
  });

  it("accepts ?demo, ?demo=true and ?demo=1", () => {
    assert.equal(demoFlagFromQuery("?demo"), true);
    assert.equal(demoFlagFromQuery("?demo=true"), true);
    assert.equal(demoFlagFromQuery("?demo=1"), true);
    assert.equal(demoFlagFromQuery("demo=true"), true);
  });

  it("does not accept an explicit off, a different param, or an empty query", () => {
    assert.equal(demoFlagFromQuery("?demo=false"), false);
    assert.equal(demoFlagFromQuery("?demo=0"), false);
    assert.equal(demoFlagFromQuery("?other=true"), false);
    assert.equal(demoFlagFromQuery(""), false);
  });

  it("is on when either the environment or the query asks for it", () => {
    assert.equal(isDemoMode({ env: "true" }), true);
    assert.equal(isDemoMode({ env: undefined, search: "?demo=true" }), true);
    assert.equal(isDemoMode({ env: "false", search: "?demo=false" }), false);
  });

  it("never turns demo mode on by reading the real environment when no env is passed", () => {
    // The test runner's own environment must not be the thing under test.
    const previous = process.env.NEXT_PUBLIC_DEMO_MODE;
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    try {
      assert.equal(isDemoMode({ search: "" }), false);
    } finally {
      if (previous !== undefined) process.env.NEXT_PUBLIC_DEMO_MODE = previous;
    }
  });
});

describe("demo fixtures", () => {
  it("names the badge with the exact required copy", () => {
    assert.equal(DEMO_BADGE_TEXT, "DEMO MODE — Static Fixture Data");
  });

  it("offers a guard address the console's own validator accepts", () => {
    assert.equal(looksLikeContractAddress(DEMO_GUARD), true);
    assert.equal(DEMO_INSTANCE.guard, DEMO_GUARD);
  });

  it("populates a healthy, actively-spending snapshot", () => {
    const { status, policy, window, identity } = demoSnapshot(NOW);
    assert.ok(status.ok && policy.ok && window.ok && identity.ok);
    if (!(status.ok && policy.ok && window.ok && identity.ok)) return;

    assert.equal(status.value.has_policy, true);
    assert.equal(status.value.admin_frozen, false);
    assert.equal(status.value.heartbeat_expired, false);
    assert.ok(status.value.last_heartbeat <= status.value.now);

    assert.ok(policy.value !== null);
    if (policy.value === null) return;
    assert.ok(policy.value.per_tx_cap > 0n);
    assert.ok(policy.value.window_cap > 0n);
    assert.ok(policy.value.recipients.length > 0);
    assert.equal(policy.value.paused, false);
    assert.ok(policy.value.dms_grace_secs > 0n);

    // The active execution window must be open at the fixture's own clock.
    assert.ok(policy.value.active_from < status.value.now);
    assert.ok(policy.value.active_until > status.value.now);

    // The rolling window is internally consistent: entries sum to the total, and
    // the total is under the cap, so the UI's percentage arithmetic is sane.
    assert.ok(window.value !== null);
    if (window.value === null) return;
    assert.ok(window.value.entries.length > 0);
    const summed = window.value.entries.reduce((total, entry) => total + entry.amount, 0n);
    assert.equal(summed, window.value.total);
    assert.ok(window.value.total > 0n);
    assert.ok(window.value.total < policy.value.window_cap);

    // The fixture claims the pinned Phase 1 artifact, which is what the console
    // would report for a real deploy of it.
    assert.equal(identity.value.reportedWasmHash, PHASE1_ARTIFACT.wasmHash);
    assert.equal(identity.value.bytes, PHASE1_ARTIFACT.wasmBytes);
    assert.equal(identity.value.match, true);
  });

  it("seeds a newest-first feed for the demo guard", () => {
    const events = demoEvents(NOW, 6);
    assert.equal(events.length, 6);
    for (const event of events) {
      assert.equal(event.contractId, DEMO_GUARD);
    }
    // Ledger-bearing rows descend with age, so the top row is the most recent.
    const ledgers = events
      .map((event) => event.ledger)
      .filter((ledger): ledger is number => ledger !== null);
    for (let index = 1; index < ledgers.length; index += 1) {
      assert.ok(ledgers[index - 1]! > ledgers[index]!, "feed must be newest first");
    }
    assert.ok(ledgers.every((ledger) => ledger > DEMO_BASE_LEDGER));
  });

  it("only ever sources a blocked decision from diagnostics, and allowed decisions from the ledger", () => {
    for (let sequence = 0; sequence < 12; sequence += 1) {
      const event = syntheticDemoEvent(sequence, NOW);
      if (event.decision?.result === "blocked") {
        assert.equal(event.source, "diagnostic");
        assert.equal(event.transactionHash, null);
        assert.equal(event.ledger, null);
      } else {
        assert.equal(event.source, "ledger");
      }
    }
  });

  it("cycles through allowed and blocked decisions rather than repeating one", () => {
    const seen = new Set<string>();
    for (let sequence = 0; sequence < 8; sequence += 1) {
      const event = syntheticDemoEvent(sequence, NOW);
      seen.add(event.kind === "auth_checked" ? `${event.decision?.result}` : event.kind);
    }
    assert.ok(seen.has("allowed"));
    assert.ok(seen.has("blocked"));
    assert.ok(seen.has("heartbeat"));
  });
});
