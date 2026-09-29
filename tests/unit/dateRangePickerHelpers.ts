/**
 * Test helper for the historical range query's timestamp filter.
 *
 * `GuardFeed.pollRange` embeds its filter inline, and constructing a real
 * `GuardFeed` needs an `rpc.Server`; this helper reproduces the filter's exact
 * predicate over fixture events so the range semantics are testable without a
 * network. It is deliberately duplicated here rather than exported from
 * `telemetry.ts` — the filter is an implementation detail of one method, and
 * the helper asserts the *behaviour* the feed promises.
 */

import type { TimeRange } from "../../lib/guard/ledgerTime.ts";

interface TimestampedLike {
  ledgerClosedAt: string | null;
}

export function pollRangeFiltersByTimestamp(
  events: TimestampedLike[],
  range: TimeRange,
): string[] {
  return events
    .filter((event) => {
      if (range.fromUnixSecs !== null && event.ledgerClosedAt) {
        if (Number(new Date(event.ledgerClosedAt)) / 1000 < range.fromUnixSecs) return false;
      }
      if (range.toUnixSecs !== null && event.ledgerClosedAt) {
        if (Number(new Date(event.ledgerClosedAt)) / 1000 > range.toUnixSecs) return false;
      }
      return true;
    })
    .map((event) => event.ledgerClosedAt) as string[];
}
