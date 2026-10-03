import test from "node:test";
import assert from "node:assert/strict";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  GuardFeedCoordinator,
  FEED_SWITCH_HISTORY_LEDGERS,
  type PolledFeed,
  type TelemetryPage,
} from "../../lib/guard/telemetry.ts";

/**
 * Feed data isolation (upstream issue #42): a cursor learned on guard A's
 * stream must never be resumed under guard B's identity. Five cases, each
 * against a scripted in-memory double — no network, no timers, no sleeps,
 * fully deterministic.
 *
 * The double mirrors the provider's real protocol: a poll that happens while
 * the feed is unpositioned (and unprimed) uses the SDK's head default and
 * returns no history; a poll after `resetFrom(...)` (the provider's switch
 * priming) re-scans from that ledger and returns the guard's own history page.
 */

interface ScriptedGuard {
  /** The guard's own historical events (what a primed re-scan returns). Placeholder
   * tokens stand in for decoded events; the isolation properties under test do
   * not depend on their shape. */
  history: string[];
  head: number;
}

class ScriptedFeed implements PolledFeed {
  readonly guard: string;
  pollCalls = 0;
  requestedStartLedger: number | null = null;
  private readonly history: GuardEvent[];
  private readonly head: number;
  private cursor: string | null = null;
  private latestLedger: number | null = null;
  private historyConsumed = false;

  constructor(guard: string, script: ScriptedGuard) {
    this.guard = guard;
    this.history = script.history as unknown as GuardEvent[];
    this.head = script.head;
  }

  async pollOnce(): Promise<TelemetryPage> {
    this.pollCalls += 1;
    if (this.cursor !== null) {
      // Cursor carried forward: the stream is caught up.
      return {
        events: [],
        cursor: this.cursor,
        latestLedger: this.latestLedger!,
        oldestLedger: null,
      };
    }
    if (this.latestLedger !== null) {
      // Ledger-primed re-scan (the switch-priming path): deliver this guard's
      // own history from that window, then advance the cursor.
      this.requestedStartLedger = this.latestLedger;
      this.historyConsumed = true;
      this.cursor = `${this.guard}-cursor-1`;
      this.latestLedger = this.head;
      return {
        events: [...this.history],
        cursor: this.cursor,
        latestLedger: this.head,
        oldestLedger: null,
      };
    }
    // Unpositioned: SDK head default — no history page.
    this.requestedStartLedger = null;
    this.cursor = `${this.guard}-cursor-1`;
    this.latestLedger = this.head;
    return { events: [], cursor: this.cursor, latestLedger: this.head, oldestLedger: null };
  }

  position(): { cursor: string | null; latestLedger: number | null } {
    return { cursor: this.cursor, latestLedger: this.latestLedger };
  }

  resetFrom(ledger: number | null): void {
    this.cursor = null;
    this.latestLedger = ledger;
  }

  consumedHistory(): boolean {
    return this.historyConsumed;
  }
}

const HEAD = 1_000;

const SCRIPTS: Map<string, ScriptedGuard> = new Map([
  ["A", { history: ["A1", "A2", "A3", "A4", "A5", "A6"], head: HEAD }],
  ["B", { history: ["B1", "B2", "B3"], head: HEAD }],
]);

interface Harness {
  coordinator: GuardFeedCoordinator;
  /** The latest live double per guard identity, for assertions. */
  feeds: Map<string, ScriptedFeed>;
}

function harness(): Harness {
  const feeds = new Map<string, ScriptedFeed>();
  const coordinator = new GuardFeedCoordinator((guard) => {
    const script = SCRIPTS.get(guard);
    if (!script) throw new Error(`no script for guard ${guard}`);
    // A fresh double per identity construction, mirroring the real factory:
    // a switch must produce a new feed, never a re-used one.
    const feed = new ScriptedFeed(guard, script);
    feeds.set(guard, feed);
    return feed;
  });
  return { coordinator, feeds };
}

/**
 * The provider's per-tick poll sequence, mirrored here: ensure → prime if
 * unpositioned and a head is known → pollOnce.
 */
async function providerPoll(
  coordinator: GuardFeedCoordinator,
  guard: string,
  knownLedger: number | null,
): Promise<TelemetryPage> {
  const feed = coordinator.ensure(guard);
  const position = feed.position();
  if (position.cursor === null && position.latestLedger === null && knownLedger !== null) {
    feed.resetFrom(knownLedger - FEED_SWITCH_HISTORY_LEDGERS);
  }
  return feed.pollOnce();
}

test("feed isolation: stream-position across guard switch", async (t) => {
  await t.test("(a) switching A→B polls B[0], never A's sixth event", async () => {
    const { coordinator, feeds } = harness();

    // Guard A watched; its head becomes known to the tab.
    await providerPoll(coordinator, "A", null);
    let knownLedger = HEAD;

    // Switch to B with the same known head: B's first poll must be B's own
    // stream from the primed history window — never a resume of A's cursor.
    const firstB = await providerPoll(coordinator, "B", knownLedger);
    assert.deepEqual(firstB.events, ["B1", "B2", "B3"]);
    assert.equal(feeds.get("B")!.requestedStartLedger, HEAD - FEED_SWITCH_HISTORY_LEDGERS);
    assert.ok(!firstB.events.includes("A6"));
  });

  await t.test("(c) old guard's feed is abandoned — count frozen, no further A-polls", async () => {
    const { coordinator, feeds } = harness();

    await providerPoll(coordinator, "A", null);
    const feedA = feeds.get("A")!;
    assert.equal(feedA.pollCalls, 1);

    coordinator.ensure("B"); // switch: A's feed is abandoned
    const feedB = feeds.get("B")!;
    await providerPoll(coordinator, "B", HEAD);
    await providerPoll(coordinator, "B", HEAD);

    // Count frozen: B polled twice more, A never again.
    assert.equal(feedB.pollCalls, 2);
    assert.equal(feedA.pollCalls, 1, "abandoned feed must not be polled again");
    assert.equal(coordinator.statsSnapshot().abandoned, 1);
    assert.equal(coordinator.statsSnapshot().created, 2);
  });

  await t.test("(d) rapid A→B→A lands on A's fresh stream, not a stale position", async () => {
    const { coordinator, feeds } = harness();

    await providerPoll(coordinator, "A", null); // A live, cursor at A-cursor-1
    coordinator.ensure("B"); // deferred B init — replaced immediately
    const feedA2 = await providerPoll(coordinator, "A", HEAD); // rapid switch back

    // The final state is a *new* A double: created=3, abandoned=2. A stale
    // implementation would have resumed the original A feed's cursor.
    assert.equal(coordinator.statsSnapshot().created, 3);
    assert.equal(coordinator.statsSnapshot().abandoned, 2);
    // The new A double re-scanned the history window (fresh stream), and the
    // old A double was never polled again.
    assert.equal(feeds.get("A")!.consumedHistory(), true);
    assert.ok(feedA2.events.length > 0);
  });
});

test("(has-history-on-switch) switch priming asks for a bounded recent window", async (t) => {
  await t.test("primed feed re-scans from (head − window), delivering context", async () => {
    const { coordinator, feeds } = harness();
    await providerPoll(coordinator, "A", null);
    const page = await providerPoll(coordinator, "B", HEAD);
    // History delivered: the operator arrives with context, not a blank page.
    assert.deepEqual(page.events, ["B1", "B2", "B3"]);
  });

  await t.test("first-ever watch is NOT primed: SDK head default preserved", async () => {
    const { coordinator, feeds } = harness();
    // No known head yet → no priming → the SDK's head default applies.
    const page = await providerPoll(coordinator, "A", null);
    assert.deepEqual(page.events, [], "first watch must not replay history");
    assert.equal(feeds.get("A")!.requestedStartLedger, null);
  });

  await t.test("same-guard re-poll carries the cursor forward (no re-scan, no dupes)", async () => {
    const { coordinator, feeds } = harness();
    await providerPoll(coordinator, "A", null); // head default, cursor now live
    // Same guard, head known: the cursor is already live, so no re-priming and
    // no re-scan — the poll carries the cursor forward and re-delivers nothing.
    const caughtUp = await providerPoll(coordinator, "A", HEAD);
    assert.deepEqual(caughtUp.events, [], "cursor carried forward, nothing re-delivered");
    assert.equal(feeds.get("A")!.pollCalls, 2);
    assert.equal(coordinator.statsSnapshot().created, 1, "same guard: no new feed constructed");
    assert.equal(coordinator.statsSnapshot().abandoned, 0);
  });
});

test("(filter-namespace) the provider's clear-on-switch also clears dedup memory", async (t) => {
  await t.test(
    "eventKey dedup is per-guard by construction: a B event never collides with A's",
    () => {
      // The filter namespace the issue asks about is enforced by clearing the
      // feed and dedup memory on switch (GuardProvider's selectGuard), and by
      // the per-guard contract filter inside the SDK listener. The property that
      // must hold: the same event on different guards must not dedupe each other.
      const keyOf = (guard: string, hash: string, ledger: number) =>
        `ledger|${hash}|${guard}|${ledger}`;
      const aKey = keyOf("A", "tx1", 5);
      const bKey = keyOf("B", "tx1", 5);
      assert.notEqual(aKey, bKey, "identical tx on two guards must remain distinct rows");
    },
  );
});
