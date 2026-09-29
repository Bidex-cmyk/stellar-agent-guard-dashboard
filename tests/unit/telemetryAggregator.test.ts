import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  CHART_WINDOWS,
  aggregateTelemetry,
  bucketLabels,
  bucketStart,
  defaultTimeOf,
  describeAggregate,
  firstSeenAt,
  formatInstant,
  formatStroops,
  type ChartWindow,
} from "../../lib/guard/telemetryAggregator.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function decision(at: string | null, result: "allowed" | "blocked" | null): GuardEvent {
  return {
    kind: result ? "auth_checked" : "heartbeat",
    topic: result ? "event_auth_checked" : "event_heartbeat",
    source: result === "blocked" ? "diagnostic" : "ledger",
    contractId: "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7",
    ledger: at ? 1 : null,
    ledgerClosedAt: at,
    transactionHash: null,
    decision: result ? { result, reason: result === "blocked" ? "admin_frozen" : null, source: "ledger" } : null,
    data: {},
  };
}

const at = (iso: string) => decision(iso, "allowed");
const byLedgerTime = (event: GuardEvent) => (event.ledgerClosedAt ? Date.parse(event.ledgerClosedAt) : null);

function assertContiguous(buckets: ReturnType<typeof aggregateTelemetry>["buckets"], bucketMs: number) {
  buckets.forEach((bucket, index) => {
    assert.equal(bucket.end - bucket.start, bucketMs, `bucket ${index} has the fixed length`);
    if (index > 0) assert.equal(bucket.start, buckets[index - 1]!.end, `bucket ${index} follows on`);
  });
}

describe("window geometry", () => {
  const now = Date.parse("2026-09-25T14:07:31Z");

  for (const [key, expected] of [["1h", 12], ["6h", 24], ["24h", 24]] as Array<[ChartWindow, number]>) {
    test(`${key}: ${expected} contiguous buckets ending with the one that holds now`, () => {
      const aggregate = aggregateTelemetry({ events: [], window: key, now, timeZone: "UTC" });
      const { bucketMs, windowMs } = CHART_WINDOWS[key];
      assert.equal(aggregate.buckets.length, expected);
      assert.equal(aggregate.windowEnd - aggregate.windowStart, windowMs);
      assert.equal(aggregate.windowEnd, bucketStart(now, bucketMs) + bucketMs);
      assert.ok(aggregate.windowStart <= now && now < aggregate.windowEnd);
      assertContiguous(aggregate.buckets, bucketMs);
    });
  }

  test("the 1h window uses 5-minute buckets aligned to the clock", () => {
    const aggregate = aggregateTelemetry({ events: [], window: "1h", now, timeZone: "UTC" });
    assert.equal(aggregate.bucketMs, 5 * MIN);
    assert.equal(aggregate.buckets.at(-1)!.label, "14:05");
    assert.equal(aggregate.buckets[0]!.label, "13:10");
  });
});

describe("counting", () => {
  const now = Date.parse("2026-09-25T14:07:00Z");

  test("allowed, blocked and other are counted per bucket, and the totals add up", () => {
    const events = [
      at("2026-09-25T14:05:00Z"),
      at("2026-09-25T14:06:59Z"),
      decision("2026-09-25T14:06:00Z", "blocked"),
      decision("2026-09-25T13:12:00Z", null),
    ];
    const aggregate = aggregateTelemetry({ events, window: "1h", now, timeZone: "UTC", timeOf: byLedgerTime });
    const last = aggregate.buckets.at(-1)!;
    assert.deepEqual([last.allowed, last.blocked, last.other], [2, 1, 0]);
    assert.equal(aggregate.buckets[0]!.other, 1);
    assert.deepEqual(
      { allowed: aggregate.totals.allowed, blocked: aggregate.totals.blocked, other: aggregate.totals.other },
      { allowed: 2, blocked: 1, other: 1 },
    );
    assert.equal(aggregate.maxCount, 3);
  });

  test("a bucket includes its start instant and excludes its end instant", () => {
    const events = [at("2026-09-25T14:00:00.000Z"), at("2026-09-25T13:59:59.999Z")];
    const aggregate = aggregateTelemetry({ events, window: "1h", now, timeZone: "UTC", timeOf: byLedgerTime });
    const index = aggregate.buckets.findIndex((bucket) => bucket.label === "14:00");
    assert.equal(aggregate.buckets[index]!.allowed, 1);
    assert.equal(aggregate.buckets[index - 1]!.allowed, 1);
  });

  test("events outside the window or with no time are reported, not silently dropped", () => {
    const events = [at("2026-09-25T12:00:00Z"), at("2026-09-25T15:00:00Z"), decision(null, "blocked")];
    const aggregate = aggregateTelemetry({ events, window: "1h", now, timeZone: "UTC", timeOf: byLedgerTime });
    assert.deepEqual(aggregate.skipped, { untimed: 1, outOfWindow: 2 });
    assert.equal(aggregate.totals.allowed + aggregate.totals.blocked, 0);
  });
});

describe("spend volume", () => {
  const now = Date.parse("2026-09-25T14:07:00Z");
  const secs = (iso: string) => BigInt(Date.parse(iso) / 1000);

  test("sums bigint amounts per bucket exactly, beyond 2^53", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a double
    const aggregate = aggregateTelemetry({
      events: [],
      spends: [
        { ts: secs("2026-09-25T14:05:10Z"), amount: huge },
        { ts: secs("2026-09-25T14:06:10Z"), amount: huge },
        { ts: Number(secs("2026-09-25T13:30:00Z")), amount: 5_000_000n },
        { ts: secs("2026-09-24T00:00:00Z"), amount: 1n }, // outside the window
      ],
      window: "1h",
      now,
      timeZone: "UTC",
    });
    const last = aggregate.buckets.at(-1)!;
    assert.equal(last.spend, 18_014_398_509_481_986n);
    assert.equal(last.spendCount, 2);
    assert.equal(aggregate.totals.spend, 18_014_398_514_481_986n);
    assert.equal(aggregate.totals.spendCount, 3);
    assert.equal(aggregate.maxSpend, 18_014_398_509_481_986n);
  });

  test("formatStroops groups digits without going through a float", () => {
    assert.equal(formatStroops(18_014_398_509_481_986n), "18,014,398,509,481,986");
    assert.equal(formatStroops(0n), "0");
    assert.equal(formatStroops(-1_234_567n), "-1,234,567");
    assert.equal(formatStroops(999n), "999");
  });
});

describe("daylight saving time", () => {
  test("US spring forward: 24 one-hour buckets, the missing 02:00 is skipped, nothing is lost", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT in America/New_York (07:00Z).
    const now = Date.parse("2026-03-08T16:30:00Z");
    const events = [at("2026-03-08T06:30:00Z"), at("2026-03-08T07:30:00Z")]; // 01:30 EST, 03:30 EDT
    const aggregate = aggregateTelemetry({
      events,
      window: "24h",
      now,
      timeZone: "America/New_York",
      timeOf: byLedgerTime,
    });
    assertContiguous(aggregate.buckets, HOUR);
    const labels = aggregate.buckets.map((bucket) => bucket.label);
    // The window spans a 23-hour local day, so 12:00 appears twice (EST, then
    // EDT) and every label carries its zone to stay distinct.
    assert.equal(labels.some((label) => label.startsWith("02:")), false, "02:00 does not exist that night");
    assert.equal(new Set(labels).size, labels.length);
    const i = labels.indexOf("01:00 EST");
    assert.equal(labels[i + 1], "03:00 EDT");
    assert.equal(aggregate.buckets[i]!.allowed, 1);
    assert.equal(aggregate.buckets[i + 1]!.allowed, 1);
    assert.equal(aggregate.totals.allowed, 2);
  });

  test("US fall back: the repeated 01:00 hour gets two distinct, zone-labelled buckets", () => {
    // 2026-11-01 02:00 EDT → 01:00 EST (06:00Z).
    const now = Date.parse("2026-11-01T15:00:00Z");
    const events = [at("2026-11-01T05:30:00Z"), at("2026-11-01T06:30:00Z")]; // both read 01:30 locally
    const aggregate = aggregateTelemetry({
      events,
      window: "24h",
      now,
      timeZone: "America/New_York",
      timeOf: byLedgerTime,
    });
    assertContiguous(aggregate.buckets, HOUR);
    const labels = aggregate.buckets.map((bucket) => bucket.label);
    assert.equal(new Set(labels).size, labels.length, "no two buckets read the same");
    const edt = labels.indexOf("01:00 EDT");
    const est = labels.indexOf("01:00 EST");
    assert.equal(est, edt + 1);
    assert.equal(aggregate.buckets[edt]!.allowed, 1);
    assert.equal(aggregate.buckets[est]!.allowed, 1);
  });

  test("UK clocks go back: London's 24h window is still exactly 24 hours", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const aggregate = aggregateTelemetry({ events: [], window: "24h", now, timeZone: "Europe/London" });
    assertContiguous(aggregate.buckets, HOUR);
    assert.equal(aggregate.windowEnd - aggregate.windowStart, 24 * HOUR);
    const labels = aggregate.buckets.map((bucket) => bucket.label);
    const oneAm = labels.filter((label) => label.startsWith("01:00 "));
    assert.equal(oneAm.length, 2, "01:00 happens twice");
    assert.notEqual(oneAm[0], oneAm[1]);
  });

  test("Lord Howe's 30-minute DST shift keeps 15-minute buckets contiguous and distinct", () => {
    // 2026-10-04 02:00 → 02:30 local (+10:30 → +11) at 15:30Z.
    const now = Date.parse("2026-10-03T18:00:00Z");
    const aggregate = aggregateTelemetry({ events: [], window: "6h", now, timeZone: "Australia/Lord_Howe" });
    assertContiguous(aggregate.buckets, 15 * MIN);
    const labels = aggregate.buckets.map((bucket) => bucket.label);
    assert.equal(new Set(labels).size, labels.length);
    assert.equal(labels.includes("02:15"), false, "02:00 to 02:30 is skipped");
  });
});

describe("time zone boundaries", () => {
  const now = Date.parse("2026-09-25T00:20:00Z");
  const events = [
    at("2026-09-24T23:58:00Z"),
    at("2026-09-25T00:02:00Z"),
    decision("2026-09-25T00:07:00Z", "blocked"),
  ];

  test("bucketing depends only on the instant, never on the display zone", () => {
    const zones = ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kathmandu", "America/St_Johns"];
    const shapes = zones.map((timeZone) =>
      aggregateTelemetry({ events, window: "1h", now, timeZone, timeOf: byLedgerTime }).buckets.map((bucket) => [
        bucket.start,
        bucket.allowed,
        bucket.blocked,
      ]),
    );
    for (const shape of shapes.slice(1)) assert.deepEqual(shape, shapes[0]);
  });

  test("crossing midnight (and the date line) is one continuous window", () => {
    const utc = aggregateTelemetry({ events, window: "1h", now, timeZone: "UTC", timeOf: byLedgerTime });
    const labels = utc.buckets.map((bucket) => bucket.label);
    assert.ok(labels.indexOf("00:00") === labels.indexOf("23:55") + 1);
    // UTC+14 and UTC-11 are on different calendar days for the same instants.
    assert.match(formatInstant(utc.buckets[0]!.start, "Pacific/Kiritimati"), /25 Sept 2026/);
    assert.match(formatInstant(utc.buckets[0]!.start, "Pacific/Pago_Pago"), /24 Sept 2026/);
  });

  test("half- and quarter-hour offsets still land on local quarter hours", () => {
    for (const timeZone of ["Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns", "Australia/Eucla"]) {
      const labels = bucketLabels(Date.parse("2026-09-25T00:00:00Z"), 15 * MIN, 8, timeZone);
      for (const label of labels) assert.match(label, /:(00|15|30|45)$/, `${timeZone} ${label}`);
    }
  });

  test("1-hour buckets in a +5:45 zone are labelled with their true local start", () => {
    assert.deepEqual(bucketLabels(Date.parse("2026-09-25T00:00:00Z"), HOUR, 2, "Asia/Kathmandu"), ["05:45", "06:45"]);
  });
});

describe("event time", () => {
  test("a committed event uses its ledger close time", () => {
    assert.equal(defaultTimeOf(at("2026-09-25T14:05:00Z"), 0), Date.parse("2026-09-25T14:05:00Z"));
  });

  test("a diagnostic refusal is placed when first seen, and stays there", () => {
    const refusal = decision(null, "blocked");
    assert.equal(firstSeenAt(refusal, 1_000), 1_000);
    assert.equal(firstSeenAt(refusal, 9_999), 1_000);
    assert.equal(defaultTimeOf(refusal, 5_000), 1_000);
  });
});

describe("accessible summary", () => {
  test("names the window, totals, spend and busiest interval", () => {
    const now = Date.parse("2026-09-25T14:07:00Z");
    const aggregate = aggregateTelemetry({
      events: [at("2026-09-25T14:05:00Z"), at("2026-09-25T14:06:00Z"), decision("2026-09-25T13:40:00Z", "blocked")],
      spends: [{ ts: BigInt(Date.parse("2026-09-25T14:05:30Z") / 1000), amount: 1_500_000_000n }],
      window: "1h",
      now,
      timeZone: "UTC",
      timeOf: byLedgerTime,
    });
    assert.equal(
      describeAggregate(aggregate),
      "Last hour in 12 5-minute intervals; 2 allowed and 1 blocked decisions; " +
        "1,500,000,000 stroops settled across 1 spend; busiest interval starting 14:05 with 2.",
    );
  });
});
