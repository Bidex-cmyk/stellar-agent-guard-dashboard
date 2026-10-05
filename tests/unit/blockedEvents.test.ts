/**
 * Blocked-decision batching: one utterance per batch, counted from the data.
 *
 * The invariants under test are the two the module exists to guarantee — the
 * count comes from the event list and never from rendered rows, and no event is
 * counted twice — plus the window arithmetic, which is asserted against an
 * injected clock rather than against the speed of the machine running the suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  BLOCKED_BATCH_MEMORY,
  BLOCKED_BATCH_WINDOW_MS,
  blockedBatchMessage,
  countNewBlockedEvents,
  createBlockedBatchAnnouncer,
  type BlockedBatchTimers,
} from "../../lib/guard/blockedEvents.ts";
import {
  MIXED_FEED_BLOCK_REASON,
  fixtureTxHash,
  mixedGuardEvents,
  specToGuardEvent,
} from "../mocks/eventFixtures.ts";
import type { AnnounceSink } from "../../lib/guard/statusTransitions.ts";

const TEST_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BASE_TIME = Date.UTC(2026, 0, 1);

/** A clock and a timer queue the test drives by hand. */
interface FakeTime {
  now: () => number;
  timers: BlockedBatchTimers;
  /** Advance the clock and run whatever came due, in scheduled order. */
  advance: (ms: number) => void;
  /** Move the clock without running timers: what a throttled tab experiences. */
  travel: (ms: number) => void;
  scheduled: () => number;
}

function fakeTime(start = 0): FakeTime {
  let current = start;
  const queue: { at: number; callback: () => void; seq: number }[] = [];
  let seq = 0;

  const runDue = (): void => {
    // Timers due at or before `current`, oldest first. One pass is enough: each
    // callback either schedules a new timer for later or schedules none.
    for (;;) {
      const due = queue
        .filter((timer) => timer.at <= current)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) return;
      queue.splice(queue.indexOf(due), 1);
      due.callback();
    }
  };

  return {
    now: () => current,
    timers: {
      schedule(callback, delayMs) {
        const timer = { at: current + Math.max(0, delayMs), callback, seq: seq++ };
        queue.push(timer);
        return () => {
          const index = queue.indexOf(timer);
          if (index >= 0) queue.splice(index, 1);
        };
      },
    },
    advance(ms) {
      current += ms;
      runDue();
    },
    travel(ms) {
      current += ms;
    },
    scheduled: () => queue.length,
  };
}

/** Collects what would have been spoken, with the region it went to. */
function recorder(): {
  messages: { message: string; priority: string }[];
  emit: AnnounceSink;
} {
  const messages: { message: string; priority: string }[] = [];
  return {
    messages,
    emit: (message, priority) => {
      messages.push({ message, priority: priority ?? "polite" });
    },
  };
}

function eventAt(sequence: number, blocked: boolean): GuardEvent {
  return specToGuardEvent(
    {
      kind: "auth_checked",
      decision: blocked
        ? { result: "blocked", reason: MIXED_FEED_BLOCK_REASON }
        : { result: "allowed" },
      ledger: 7_000_000 + sequence,
      ledgerClosedAt: new Date(BASE_TIME + sequence * 1_000).toISOString(),
      transactionHash: fixtureTxHash(sequence),
      data: {},
    },
    TEST_CONTRACT,
  );
}

/** `count` events, every tenth one blocked, starting at `from`. */
function streamOf(count: number, from = 0, blockedEvery = 10): GuardEvent[] {
  const events: GuardEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const sequence = from + index;
    events.push(eventAt(sequence, blockedEvery > 0 && sequence % blockedEvery === 3));
  }
  return events;
}

test("a batch is one utterance, however many refusals arrived in it", () => {
  const time = fakeTime(1_000);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });

  // A poll's worth of refusals, then two empty polls inside the same window.
  const burst = streamOf(20, 0, 10).filter((event) => event.decision?.result === "blocked");
  assert.equal(burst.length, 2, "the fixture really does carry two refusals");
  announcer.observe(burst);
  announcer.observe(burst);
  announcer.observe([]);
  assert.deepEqual(spoken.messages, [], "nothing is spoken before the window closes");
  assert.equal(announcer.getPending(), 2);
  assert.equal(time.scheduled(), 1, "the window is one timer, not one per event");

  time.advance(2_000);
  assert.deepEqual(spoken.messages, [{ message: "2 new blocked events", priority: "assertive" }]);
  assert.equal(announcer.getPending(), 0, "the badge clears once the batch has been spoken");
});

test("the window is fixed and anchored to the first event, not slid by the last", () => {
  const time = fakeTime(0);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });

  announcer.observe([eventAt(3, true)]);
  // A steady stream: one refusal every 400ms, without pause. A sliding window
  // would be pushed back by every arrival and never close, so the operator would
  // hear nothing at all for as long as the agent kept misbehaving.
  for (let step = 1; step <= 12; step += 1) {
    time.advance(400);
    announcer.observe([eventAt(3 + step * 10, true)]);
  }
  assert.deepEqual(
    spoken.messages.map((item) => item.message),
    ["5 new blocked events", "5 new blocked events"],
    "the two 2s windows that closed each counted the five that arrived in them",
  );
  assert.equal(announcer.getPending(), 3, "the tail since the last window is still pending");
});

test("the window closes exactly on its boundary, not a millisecond early", () => {
  const time = fakeTime(10_000);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });

  announcer.observe([eventAt(3, true)]);
  time.advance(1_999);
  assert.equal(spoken.messages.length, 0, "one millisecond early is still inside the window");
  time.advance(1);
  assert.equal(spoken.messages.length, 1, "the window closes on its boundary");
});

test("a throttled background tab speaks its backlog when it is looked at again", () => {
  const time = fakeTime(0);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });

  announcer.observe([eventAt(3, true)]);
  // The tab was backgrounded: the timer never ran, minutes pass, and nothing
  // else was observed. A timer-only implementation would still be holding the
  // batch when the operator came back.
  time.travel(600_000);
  assert.equal(spoken.messages.length, 0, "no timer ran, so nothing was spoken");

  // One new event arrives on wake-up. The backlog is announced first, with the
  // event that woke the tab folded into it, rather than as two counts in a row.
  announcer.observe([eventAt(13, true)]);
  assert.deepEqual(
    spoken.messages,
    [{ message: "2 new blocked events", priority: "assertive" }],
    "the backlog and the arrival that woke the tab are one utterance",
  );
  assert.equal(announcer.getPending(), 0, "and nothing is left silently uncounted");
});

test("an event is counted once, however many times the feed re-renders it", () => {
  const time = fakeTime(0);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });
  const events = streamOf(30);

  // The same array, re-observed on every render, as a re-render would.
  announcer.observe(events);
  assert.equal(announcer.getPending(), 3);
  announcer.observe(events);
  announcer.observe(events);
  assert.equal(announcer.getPending(), 3, "re-observing the same events adds nothing");

  // The feed re-polls and prepends: the whole buffer again, plus new arrivals.
  announcer.observe([...streamOf(10, 30), ...events]);
  assert.equal(announcer.getPending(), 4, "only the new arrival is counted");

  time.advance(2_000);
  assert.deepEqual(spoken.messages, [{ message: "4 new blocked events", priority: "assertive" }]);
});

test("the count comes from the event data, not from what is on screen", () => {
  // 5,000 rows with 10 blocked decisions: a table this size is windowed,
  // virtualized or filtered in the browser, so a count taken from rendered rows
  // would depend on the viewport. The count here is exact and does not.
  const all: GuardEvent[] = [];
  for (let index = 0; index < 5_000; index += 1) {
    all.push(eventAt(index, index < 10));
  }
  const seen = new Set<string>();
  const fresh = countNewBlockedEvents(all, seen);
  assert.equal(all.length, 5_000);
  assert.equal(fresh, 10, "every blocked decision in the buffer is counted");
  assert.equal(
    countNewBlockedEvents(all, seen),
    10,
    "and the count is a pure function of the data",
  );

  const time = fakeTime(0);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });
  assert.equal(announcer.observe(all), 10);
  time.advance(2_000);
  assert.deepEqual(spoken.messages, [{ message: "10 new blocked events", priority: "assertive" }]);
});

test("the shared mixed feed's ten refusals are the ten that get counted", () => {
  // Issue #113's fixture: 35 approved, 10 blocked, 5 heartbeats. If the count
  // were off by the heartbeat rows or the allowed rows the two numbers would
  // disagree, and the badge would contradict the filtered table underneath it.
  const events = mixedGuardEvents(TEST_CONTRACT);
  const fresh = countNewBlockedEvents(events, new Set());
  assert.equal(fresh, events.filter((event) => event.decision?.result === "blocked").length);
  assert.equal(fresh, 10);
});

test("a cleared buffer does not re-announce what the operator already heard", () => {
  const time = fakeTime(0);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });

  const events = streamOf(20);
  announcer.observe(events);
  time.advance(2_000);
  assert.equal(spoken.messages.length, 1);

  // "Clear buffer" empties the table; the events are gone from the data. Polling
  // carries on with a cursor, so they are not re-delivered — but if a historical
  // query brings the same events back, they are already-known, not new.
  announcer.observe([]);
  announcer.observe(events);
  time.advance(2_000);
  assert.equal(spoken.messages.length, 1, "re-delivering known events is not news");
});

test("the identity memory is bounded, and the bound is the documented one", () => {
  const time = fakeTime(0);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({
    emit: spoken.emit,
    ...time,
    windowMs: 2_000,
    memoryLimit: 50,
  });

  for (let chunk = 0; chunk < 4; chunk += 1) {
    announcer.observe(streamOf(40, chunk * 40, 10));
    time.advance(2_000);
  }
  assert.equal(spoken.messages.length, 4, "each chunk of the stream is announced as it closes");
  assert.ok(BLOCKED_BATCH_MEMORY >= 5_000, "the default bound covers a full-size buffer");
  assert.ok(BLOCKED_BATCH_WINDOW_MS >= 2_000, "the window is long enough to span a poll");
});

test("an empty window and a disposed announcer are both no-ops", () => {
  const time = fakeTime(0);
  const spoken = recorder();
  const announcer = createBlockedBatchAnnouncer({ emit: spoken.emit, ...time, windowMs: 2_000 });

  announcer.flush();
  assert.deepEqual(spoken.messages, [], "there is nothing to say about no events");
  announcer.observe([]);
  assert.equal(time.scheduled(), 0, "no blocked event means no timer");

  announcer.observe([eventAt(3, true)]);
  assert.equal(announcer.getPending(), 1);
  announcer.dispose();
  // A batch opened just before the panel went away is not spoken after it does:
  // the events are still counted and still shown, but the utterance would land
  // on a live region nobody is listening to any more.
  time.advance(10_000);
  assert.deepEqual(spoken.messages, []);
  assert.equal(announcer.getPending(), 1);
});

test("the badge message is countable by ear: one is not '1 events'", () => {
  assert.equal(blockedBatchMessage(1), "1 new blocked event");
  assert.equal(blockedBatchMessage(0), "0 new blocked events");
  assert.equal(blockedBatchMessage(2), "2 new blocked events");
  assert.equal(blockedBatchMessage(1_250), "1250 new blocked events");
});
