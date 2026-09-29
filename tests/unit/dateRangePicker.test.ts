import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AVERAGE_LEDGER_CLOSE_SECS,
  datetimeLocalToUnixSecs,
  estimateLedgerAtTime,
  estimateTimeAtLedger,
  ledgerWindowForRange,
  resolvePreset,
  unixSecsToDatetimeLocal,
  validateRange,
  type LedgerAnchor,
} from "../../lib/guard/ledgerTime.ts";
import { pollRangeFiltersByTimestamp } from "./dateRangePickerHelpers.ts";

/** An anchor whose arithmetic is easy to check by hand: ledger 1000 at t=0. */
const ANCHOR: LedgerAnchor = { ledger: 1_000, closeTimeSecs: 0 };

test("the average close interval is the protocol's ~5s target", () => {
  assert.equal(AVERAGE_LEDGER_CLOSE_SECS, 5);
});

test("a past timestamp maps to an earlier ledger, at ~1 ledger per 5 seconds", () => {
  // 100 ledgers of history = 500 seconds, minus the one-ledger margin.
  assert.equal(estimateLedgerAtTime(ANCHOR, -500), 899);
  // 10 seconds back = 2 ledgers back, minus the margin.
  assert.equal(estimateLedgerAtTime(ANCHOR, -10), 997);
});

test("a future timestamp maps ahead of the anchor", () => {
  assert.equal(estimateLedgerAtTime(ANCHOR, 500), 1_099);
});

test("the estimate floors, then steps one ledger back as safety margin", () => {
  // 7 seconds is 1.4 ledgers; floor(1.4) = 1, minus the margin = 0 offset.
  assert.equal(estimateLedgerAtTime(ANCHOR, 7), 1_000);
  // Exactly on a boundary still steps back: 5s = 1 ledger, minus margin = 0.
  assert.equal(estimateLedgerAtTime(ANCHOR, 5), 1_000);
});

test("the estimate never goes below ledger 1 via the range window clamp", () => {
  const window = ledgerWindowForRange(ANCHOR, { fromUnixSecs: -100_000, toUnixSecs: null });
  assert.ok(window);
  assert.ok(window.startLedger >= 1);
});

test("the inverse mapping is display-consistent with the forward estimate", () => {
  const time = estimateTimeAtLedger(ANCHOR, 1_100);
  assert.equal(time, 500);
  // Round trip: mapping the estimated close time of a ledger back to a ledger
  // lands within a ledger of it (the margin is one ledger by design).
  const ledger = estimateLedgerAtTime(ANCHOR, time);
  assert.ok(Math.abs(ledger - 1_100) <= 2);
});

test("a non-standard close interval is honoured, e.g. a local dev chain", () => {
  assert.equal(estimateLedgerAtTime(ANCHOR, -100, 10), 989);
});

test("presets resolve to lower-bound-only ranges ending at now", () => {
  const now = 1_800_000_000;
  assert.deepEqual(resolvePreset("1h", now), { fromUnixSecs: now - 3_600, toUnixSecs: null });
  assert.deepEqual(resolvePreset("24h", now), { fromUnixSecs: now - 86_400, toUnixSecs: null });
  assert.deepEqual(resolvePreset("7d", now), { fromUnixSecs: now - 7 * 86_400, toUnixSecs: null });
  assert.deepEqual(resolvePreset("custom", now), { fromUnixSecs: null, toUnixSecs: null });
});

test("datetime-local values parse in local time and invalid ones return null", () => {
  // A full ISO-ish datetime-local value parses to its wall-clock second.
  const parsed = datetimeLocalToUnixSecs("2026-09-16T12:00");
  assert.ok(parsed !== null);
  assert.equal(unixSecsToDatetimeLocal(parsed!), "2026-09-16T12:00");

  assert.equal(datetimeLocalToUnixSecs(""), null);
  assert.equal(datetimeLocalToUnixSecs("not a date"), null);
});

test("unixSecsToDatetimeLocal renders zero-padded local wall clock", () => {
  // 2026-01-05T03:07 local — zero-padded month, day, hours and minutes.
  const value = unixSecsToDatetimeLocal(datetimeLocalToUnixSecs("2026-01-05T03:07")!);
  assert.equal(value, "2026-01-05T03:07");
});

test("range validation reports missing bounds and inverted ranges", () => {
  assert.match(validateRange({ fromUnixSecs: null, toUnixSecs: null })!, /Pick a start and end/);
  assert.match(
    validateRange({ fromUnixSecs: 200, toUnixSecs: 100 })!,
    /start date must not be after/,
  );
  assert.equal(validateRange({ fromUnixSecs: 100, toUnixSecs: null }), null);
  assert.equal(validateRange({ fromUnixSecs: 100, toUnixSecs: 200 }), null);
  assert.equal(validateRange({ fromUnixSecs: null, toUnixSecs: 200 }), null);
});

test("a time range converts to a ledger window for the query cursor", () => {
  const window = ledgerWindowForRange(ANCHOR, { fromUnixSecs: -500, toUnixSecs: -100 });
  assert.ok(window);
  // From: 100 ledgers back, minus the one-ledger margin.
  assert.equal(window.startLedger, 899);
  // To: 20 ledgers back, minus the margin — never below the start.
  assert.equal(window.endLedger, 979);
});

test("an unresolvable range yields no window for the query to issue", () => {
  assert.equal(ledgerWindowForRange(ANCHOR, { fromUnixSecs: null, toUnixSecs: null }), null);
  assert.equal(ledgerWindowForRange(ANCHOR, { fromUnixSecs: 500, toUnixSecs: 100 }), null);
});

test("pollRange's timestamp filter keeps only events inside the requested window", () => {
  // The ledger estimate can be off by a ledger or two; the filter is what
  // makes the range honest. Events just outside both bounds must be dropped.
  const kept = pollRangeFiltersByTimestamp(
    [
      { ledgerClosedAt: new Date((90 - 60) * 1000).toISOString() },
      { ledgerClosedAt: new Date(100 * 1000).toISOString() },
      { ledgerClosedAt: new Date(200 * 1000).toISOString() },
      { ledgerClosedAt: new Date((300 + 60) * 1000).toISOString() },
    ],
    { fromUnixSecs: 100, toUnixSecs: 300 },
  );
  assert.deepEqual(kept, [new Date(100 * 1000).toISOString(), new Date(200 * 1000).toISOString()]);
});

test("an open-ended upper bound keeps every event after the start", () => {
  const kept = pollRangeFiltersByTimestamp(
    [
      { ledgerClosedAt: new Date(50 * 1000).toISOString() },
      { ledgerClosedAt: new Date(150 * 1000).toISOString() },
    ],
    { fromUnixSecs: 100, toUnixSecs: null },
  );
  assert.deepEqual(kept, [new Date(150 * 1000).toISOString()]);
});
