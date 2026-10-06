import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { withIdentity } from "../mocks/eventFixtures.ts";
import {
  FEED_GUARD_CAP,
  MultiGuardFeed,
  attributionLabel,
  matchesGuardFilter,
  toggleGuardFilter,
  type FeedSource,
  type GuardFeedLike,
} from "../../lib/guard/feedSubscriptions.ts";

const GUARD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GUARD_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const GUARD_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const GUARD_D = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const GUARD_E = "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const GUARD_F = "CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

function source(guard: string, label: string): FeedSource {
  return { guard, label };
}

function event(
  contractId: string,
  ledger: number | null,
  options: { blocked?: boolean; hash?: string | null } = {},
): GuardEvent {
  const blocked = options.blocked === true;
  return withIdentity({
    kind: "auth_checked",
    topic: GUARD_EVENT_TOPICS.authChecked,
    source: blocked ? "diagnostic" : "ledger",
    contractId,
    ledger,
    ledgerClosedAt: null,
    transactionHash: blocked ? null : (options.hash ?? `tx-${contractId.slice(0, 3)}-${ledger}`),
    decision: {
      result: blocked ? "blocked" : "allowed",
      reason: blocked ? "per_tx_cap_exceeded" : null,
      source: blocked ? "diagnostic" : "ledger",
    },
    data: {},
  });
}

/**
 * A mock runner that stands in for one `GuardFeed`. It records its own poll
 * count and whether it has been stopped, and can be made to throw or to emit a
 * scripted page so a test can prove exactly which streams delivered.
 */
interface MockRunner extends GuardFeedLike {
  polls: number;
  stopped: boolean;
  page: () => Promise<{ events: GuardEvent[]; cursor: string; latestLedger: number }>;
}

function createHarness() {
  const created: MockRunner[] = [];
  const active = new Set<MockRunner>();
  const stopCalls: string[] = [];

  const createFeed = (guard: string): GuardFeedLike => {
    const runner: MockRunner = {
      guard,
      polls: 0,
      stopped: false,
      page: async () => ({ events: [], cursor: "", latestLedger: 0 }),
      async pollOnce() {
        runner.polls += 1;
        return runner.page();
      },
      stop() {
        runner.stopped = true;
        active.delete(runner);
        stopCalls.push(guard);
      },
    };
    created.push(runner);
    active.add(runner);
    return runner;
  };

  return { createFeed, created, active, stopCalls };
}

describe("multi-guard feed cap (issue #23)", () => {
  it("tails exactly N guards for N <= cap", () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ cap: FEED_GUARD_CAP, createFeed: harness.createFeed });

    feed.sync([source(GUARD_A, "Guard A")]);
    assert.equal(feed.listenerCount(), 1);
    assert.equal(feed.isCapped(), false);

    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B"), source(GUARD_C, "Guard C")]);
    assert.equal(feed.listenerCount(), 3);
    assert.equal(feed.droppedCount(), 0);
  });

  it("caps a cap+1 registry, keeps the first cap, and names the dropped guard", () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ cap: FEED_GUARD_CAP, createFeed: harness.createFeed });

    feed.sync([
      source(GUARD_A, "Guard A"),
      source(GUARD_B, "Guard B"),
      source(GUARD_C, "Guard C"),
      source(GUARD_D, "Guard D"),
      source(GUARD_E, "Guard E"),
      source(GUARD_F, "Guard F"),
    ]);

    // listeners == cap, not registry size — this is the assertion the UI's cap
    // notice is driven by (`droppedCount() > 0`).
    assert.equal(feed.listenerCount(), FEED_GUARD_CAP);
    assert.equal(feed.isCapped(), true);
    assert.equal(feed.droppedCount(), 1);
    assert.deepEqual(
      feed.droppedLabels(),
      ["Guard F"],
      "the guard past the cap is named, never silently dropped",
    );
    assert.deepEqual(
      feed.guards().map((entry) => entry.label),
      ["Guard A", "Guard B", "Guard C", "Guard D", "Guard E"],
    );
  });

  it("collapses duplicate and empty registry entries before applying the cap", () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ cap: 2, createFeed: harness.createFeed });
    feed.sync([
      source(GUARD_A, "Guard A"),
      source(GUARD_A, "Guard A again"),
      source("  ", "blank"),
      source(GUARD_B, "Guard B"),
      source(GUARD_C, "Guard C"),
    ]);
    assert.equal(feed.listenerCount(), 2);
    assert.equal(feed.droppedCount(), 1);
    assert.deepEqual(feed.droppedLabels(), ["Guard C"]);
  });
});

describe("per-guard attribution (issue #23)", () => {
  it("attributes every row to its source guard's registry label", async () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ createFeed: harness.createFeed });
    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B")]);

    // Script one stream per address.
    const runnerA = harness.created.find((runner) => runner.guard === GUARD_A);
    const runnerB = harness.created.find((runner) => runner.guard === GUARD_B);
    assert.ok(runnerA && runnerB);
    runnerA.page = async () => ({ events: [event(GUARD_A, 100)], cursor: "a", latestLedger: 100 });
    runnerB.page = async () => ({ events: [event(GUARD_B, 101)], cursor: "b", latestLedger: 101 });

    const page = await feed.pollAll();
    assert.equal(page.events.length, 2);
    const labels = page.events.map((row) => attributionLabel(row.contractId, feed.guards()));
    assert.deepEqual(labels.sort(), ["Guard A", "Guard B"]);
    // Newest-first across guards: the higher ledger comes first.
    assert.equal(page.latestLedger, 101);
    assert.equal(page.events[0]?.contractId, GUARD_B);
  });

  it("isolates one guard's poll failure from the others", async () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ createFeed: harness.createFeed });
    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B")]);

    const runnerA = harness.created.find((runner) => runner.guard === GUARD_A)!;
    const runnerB = harness.created.find((runner) => runner.guard === GUARD_B)!;
    runnerA.page = async () => {
      throw new Error("rpc unavailable for A");
    };
    runnerB.page = async () => ({ events: [event(GUARD_B, 200)], cursor: "b", latestLedger: 200 });

    const page = await feed.pollAll();
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.contractId, GUARD_B);
    const failed = page.watch.filter((entry) => !entry.ok);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.guard, GUARD_A);
    assert.match(failed[0]?.error ?? "", /rpc unavailable for A/);
    assert.equal(page.watch.find((entry) => entry.guard === GUARD_B)?.ok, true);
  });

  it("puts diagnostic (un-broadcast) rows first, since they are the freshest", async () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ createFeed: harness.createFeed });
    feed.sync([source(GUARD_A, "Guard A")]);
    const runnerA = harness.created.find((runner) => runner.guard === GUARD_A)!;
    runnerA.page = async () => ({
      events: [event(GUARD_A, 300), event(GUARD_A, null, { blocked: true })],
      cursor: "a",
      latestLedger: 300,
    });
    const page = await feed.pollAll();
    assert.equal(page.events[0]?.source, "diagnostic");
    assert.equal(page.events[1]?.ledger, 300);
  });
});

describe("listener lifecycle reconciliation (issue #23, central acceptance)", () => {
  it("stops and removes a deleted guard's listener; its stream no longer delivers", async () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ createFeed: harness.createFeed });
    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B"), source(GUARD_C, "Guard C")]);
    assert.equal(feed.listenerCount(), 3);

    const runnerB = harness.created.find((runner) => runner.guard === GUARD_B)!;
    runnerB.page = async () => ({ events: [event(GUARD_B, 150)], cursor: "b", latestLedger: 150 });

    // Remove B from the registry.
    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_C, "Guard C")]);
    assert.equal(feed.listenerCount(), 2, "the deleted guard's listener is removed");
    assert.equal(runnerB.stopped, true, "the deleted guard's runner is stopped");
    assert.equal(harness.stopCalls.includes(GUARD_B), true);

    const pollsAfterRemoval = runnerB.polls;
    const page = await feed.pollAll();
    assert.equal(runnerB.polls, pollsAfterRemoval, "the removed stream is never polled again");
    assert.equal(
      page.events.some((row) => row.contractId === GUARD_B),
      false,
      "no events from the removed guard after removal",
    );
  });

  it("starts a listener for an added guard and grows the count by one", () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ createFeed: harness.createFeed });
    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B")]);
    assert.equal(feed.listenerCount(), 2);

    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B"), source(GUARD_C, "Guard C")]);
    assert.equal(feed.listenerCount(), 3);
    assert.equal(harness.created.filter((runner) => runner.guard === GUARD_C).length, 1);
  });

  it("leaves the listener count at the current registry size after repeated add/remove (leak test)", () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ createFeed: harness.createFeed });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      feed.sync([
        source(GUARD_A, "Guard A"),
        source(GUARD_B, "Guard B"),
        source(GUARD_C, "Guard C"),
      ]);
      assert.equal(feed.listenerCount(), 3);
      assert.equal(harness.active.size, 3, "no stopped runner is left in the active set");

      feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B")]);
      assert.equal(feed.listenerCount(), 2);
      assert.equal(harness.active.size, 2);
    }

    // Final state: one listener per registry entry, no residue from the churn.
    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B")]);
    assert.equal(feed.listenerCount(), 2);
    assert.deepEqual(
      feed.guards().map((entry) => entry.guard),
      [GUARD_A, GUARD_B],
    );
  });

  it("stopAll releases every listener and refuses further syncs", async () => {
    const harness = createHarness();
    const feed = new MultiGuardFeed({ createFeed: harness.createFeed });
    feed.sync([source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B")]);

    feed.stopAll();
    assert.equal(feed.listenerCount(), 0);
    assert.equal(harness.active.size, 0);

    feed.sync([source(GUARD_C, "Guard C")]);
    assert.equal(feed.listenerCount(), 0, "a stopped supervisor never restarts listeners");

    const page = await feed.pollAll();
    assert.deepEqual(page.events, []);
    assert.deepEqual(page.watch, []);
  });
});

describe("guard-chip filter composition (issue #23)", () => {
  it("passes every row when no guard is selected", () => {
    assert.equal(matchesGuardFilter(GUARD_A, new Set()), true);
    assert.equal(matchesGuardFilter(null, new Set()), true);
  });

  it("passes only the selected guards' rows once a chip is active", () => {
    const selected = new Set([GUARD_A, GUARD_C]);
    assert.equal(matchesGuardFilter(GUARD_A, selected), true);
    assert.equal(matchesGuardFilter(GUARD_B, selected), false);
    assert.equal(matchesGuardFilter(GUARD_C, selected), true);
    // An event with no contract id cannot be confirmed as one of the selection.
    assert.equal(matchesGuardFilter(null, selected), false);
  });

  it("toggles a chip without mutating the original set", () => {
    const original = new Set([GUARD_A]);
    const added = toggleGuardFilter(original, GUARD_B);
    assert.deepEqual([...added].sort(), [GUARD_A, GUARD_B]);
    assert.deepEqual([...original], [GUARD_A], "the previous set is untouched");

    const removed = toggleGuardFilter(added, GUARD_A);
    assert.deepEqual([...removed], [GUARD_B]);
  });

  it("falls back to the address when a guard has no registry label", () => {
    assert.equal(attributionLabel(GUARD_D, [source(GUARD_A, "Guard A")]), GUARD_D);
    assert.equal(attributionLabel(null, [source(GUARD_A, "Guard A")]), null);
  });
});
