/**
 * Time-bucketing for the telemetry chart.
 *
 * Two inputs, from two different places, because no single source has both:
 *
 *   - **Outcome counts** come from the feed's guard events: an `auth_checked`
 *     event's decision says whether a call was allowed or blocked. The decision
 *     event carries no amount, so it cannot give spend.
 *   - **Spend volume** comes from the guard's own rolling-window ledger
 *     (`DataKey::Window`): one `{ ts, amount }` entry per settled spend. It
 *     is the contract's own accounting, but it only holds spends still inside
 *     the policy's `window_secs`, since older entries are pruned on chain.
 *
 * **Time.** Buckets are fixed-length spans of absolute time aligned to the
 * Unix epoch, not to a local wall clock. Every bucket is exactly `bucketMs`
 * long, so a daylight-saving change cannot make an hour disappear, repeat, or
 * come out 23 or 25 hours long. The time zone only affects the *labels*, and a
 * label shows the zone abbreviation whenever two buckets would otherwise read
 * the same (the repeated hour when clocks go back).
 *
 * Amounts are `bigint` throughout. They are token base units (stroops for a
 * 7-decimal SAC), and a sum of them can exceed 2^53.
 */

import type { GuardEvent } from "stellar-agent-guard-sdk";

export type ChartWindow = "1h" | "6h" | "24h";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Window length and bucket size for each selectable window. */
export const CHART_WINDOWS: Record<ChartWindow, { windowMs: number; bucketMs: number; label: string }> = {
  "1h": { windowMs: HOUR, bucketMs: 5 * MINUTE, label: "Last hour" },
  "6h": { windowMs: 6 * HOUR, bucketMs: 15 * MINUTE, label: "Last 6 hours" },
  "24h": { windowMs: 24 * HOUR, bucketMs: HOUR, label: "Last 24 hours" },
};

/** One settled spend from the guard's rolling window. `ts` is Unix seconds, as stored on chain. */
export interface SpendEntry {
  ts: bigint | number;
  amount: bigint;
}

export interface ChartBucket {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms. */
  end: number;
  /** Start time as local wall-clock text in the chart's time zone. */
  label: string;
  allowed: number;
  blocked: number;
  /** Lifecycle and heartbeat events: no decision either way. */
  other: number;
  /** Sum of settled spend amounts, in token base units. */
  spend: bigint;
  spendCount: number;
}

export interface TelemetryAggregate {
  window: ChartWindow;
  timeZone: string;
  bucketMs: number;
  /** Inclusive, epoch ms. */
  windowStart: number;
  /** Exclusive, epoch ms: the end of the bucket that contains `now`. */
  windowEnd: number;
  buckets: ChartBucket[];
  totals: { allowed: number; blocked: number; other: number; spend: bigint; spendCount: number };
  /** Events with no usable time, or outside the window. They are counted here so the chart never hides them silently. */
  skipped: { untimed: number; outOfWindow: number };
  maxCount: number;
  maxSpend: bigint;
}

export interface AggregateParams {
  events: readonly GuardEvent[];
  spends?: readonly SpendEntry[];
  window: ChartWindow;
  /** Epoch ms. */
  now: number;
  /** IANA zone for labels. Defaults to the runtime's zone. */
  timeZone?: string;
  /**
   * When an event happened, in epoch ms, or null if unknown. Defaults to the
   * ledger close time, falling back to when this console first saw the event
   * (the only time a never-committed diagnostic refusal has).
   */
  timeOf?: (event: GuardEvent) => number | null;
}

/**
 * When this console first saw each event object.
 *
 * A diagnostic refusal never reaches a ledger, so it has no close time. The
 * feed keeps event objects by reference across renders, so identity is a
 * stable key, and a WeakMap lets cleared events be garbage collected.
 */
const firstSeen = new WeakMap<GuardEvent, number>();

export function firstSeenAt(event: GuardEvent, now: number = Date.now()): number {
  const known = firstSeen.get(event);
  if (known !== undefined) return known;
  firstSeen.set(event, now);
  return now;
}

export function defaultTimeOf(event: GuardEvent, now: number = Date.now()): number | null {
  if (event.ledgerClosedAt) {
    const parsed = Date.parse(event.ledgerClosedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return firstSeenAt(event, now);
}

/** Epoch-aligned floor: the start of the bucket containing `ms`. */
export function bucketStart(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

export function aggregateTelemetry(params: AggregateParams): TelemetryAggregate {
  const { windowMs, bucketMs } = CHART_WINDOWS[params.window];
  const timeZone = params.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const windowEnd = bucketStart(params.now, bucketMs) + bucketMs;
  const windowStart = windowEnd - windowMs;
  const count = windowMs / bucketMs;
  const labels = bucketLabels(windowStart, bucketMs, count, timeZone);

  const buckets: ChartBucket[] = Array.from({ length: count }, (_, index) => ({
    start: windowStart + index * bucketMs,
    end: windowStart + (index + 1) * bucketMs,
    label: labels[index]!,
    allowed: 0,
    blocked: 0,
    other: 0,
    spend: 0n,
    spendCount: 0,
  }));

  const indexOf = (ms: number): number | null =>
    ms >= windowStart && ms < windowEnd ? Math.floor((ms - windowStart) / bucketMs) : null;

  const timeOf = params.timeOf ?? ((event: GuardEvent) => defaultTimeOf(event, params.now));
  const skipped = { untimed: 0, outOfWindow: 0 };

  for (const event of params.events) {
    const at = timeOf(event);
    if (at === null || !Number.isFinite(at)) {
      skipped.untimed += 1;
      continue;
    }
    const index = indexOf(at);
    if (index === null) {
      skipped.outOfWindow += 1;
      continue;
    }
    const bucket = buckets[index]!;
    if (event.decision?.result === "allowed") bucket.allowed += 1;
    else if (event.decision?.result === "blocked") bucket.blocked += 1;
    else bucket.other += 1;
  }

  for (const spend of params.spends ?? []) {
    const index = indexOf(Number(spend.ts) * 1000);
    if (index === null) continue;
    const bucket = buckets[index]!;
    bucket.spend += spend.amount;
    bucket.spendCount += 1;
  }

  const totals = { allowed: 0, blocked: 0, other: 0, spend: 0n, spendCount: 0 };
  let maxCount = 0;
  let maxSpend = 0n;
  for (const bucket of buckets) {
    totals.allowed += bucket.allowed;
    totals.blocked += bucket.blocked;
    totals.other += bucket.other;
    totals.spend += bucket.spend;
    totals.spendCount += bucket.spendCount;
    maxCount = Math.max(maxCount, bucket.allowed + bucket.blocked);
    if (bucket.spend > maxSpend) maxSpend = bucket.spend;
  }

  return {
    window: params.window,
    timeZone,
    bucketMs,
    windowStart,
    windowEnd,
    buckets,
    totals,
    skipped,
    maxCount,
    maxSpend,
  };
}

/**
 * Wall-clock labels for consecutive buckets.
 *
 * `HH:mm` normally. If two labels in the series would be identical, which
 * happens in the repeated hour when clocks go back, every label gets the
 * zone's short name (`01:00 EDT`, `01:00 EST`) so no two read the same.
 */
export function bucketLabels(start: number, bucketMs: number, count: number, timeZone: string): string[] {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const plain = Array.from({ length: count }, (_, index) => time.format(start + index * bucketMs));
  if (new Set(plain).size === plain.length) return plain;
  const zoned = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
  return plain.map((label, index) => {
    const zone = zoned.formatToParts(start + index * bucketMs).find((part) => part.type === "timeZoneName");
    return zone ? `${label} ${zone.value}` : label;
  });
}

/** A full date-time for a tooltip, e.g. `25 Sept 2026, 14:05 UTC`. */
export function formatInstant(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(ms);
}

/** Exact integer with thousands separators; never goes through a float. */
export function formatStroops(amount: bigint): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** The one-sentence summary used as the chart's accessible name. */
export function describeAggregate(aggregate: TelemetryAggregate): string {
  const { totals } = aggregate;
  const window = CHART_WINDOWS[aggregate.window].label.toLowerCase();
  const minutes = aggregate.bucketMs / MINUTE;
  const size = minutes >= 60 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  let busiest: ChartBucket | null = null;
  for (const bucket of aggregate.buckets) {
    if (bucket.allowed + bucket.blocked > 0 && (!busiest || bucket.allowed + bucket.blocked > busiest.allowed + busiest.blocked)) {
      busiest = bucket;
    }
  }
  const parts = [
    `${window[0]!.toUpperCase()}${window.slice(1)} in ${aggregate.buckets.length} ${size} intervals`,
    `${totals.allowed} allowed and ${totals.blocked} blocked decision${totals.allowed + totals.blocked === 1 ? "" : "s"}`,
    `${formatStroops(totals.spend)} stroops settled across ${totals.spendCount} spend${totals.spendCount === 1 ? "" : "s"}`,
  ];
  if (busiest) parts.push(`busiest interval starting ${busiest.label} with ${busiest.allowed + busiest.blocked}`);
  return `${parts.join("; ")}.`;
}
