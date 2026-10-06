"use client";

/**
 * The count of blocked decisions the operator has not been told about yet.
 *
 * The badge is visible and the announcement is not: the count is written on the
 * panel, and the same count is spoken once per batch through the shell's live
 * region (see `lib/guard/blockedEvents.ts`). Keeping the two apart is the point
 * — per-row announcements would be a firehose, and a badge nobody is told about
 * is just decoration.
 *
 * The count is the announcer's own, read through `useSyncExternalStore` rather
 * than copied into component state. It has to be: the announcer decides what is
 * pending and when it has been spoken, and a mirrored copy can disagree with it
 * for a render — showing a number that has already been announced at the exact
 * moment the operator is cross-checking the table against it. The events arrive
 * as a prop rather than through context so the count is a function of the data
 * the feed holds: a filter, a paused queue or a virtualized list can each hide a
 * blocked event from the DOM while it is plainly in the stream, and a count
 * taken from the rendered rows would be a number the operator cannot reconcile.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { blockedBatchMessage, createBlockedBatchAnnouncer } from "../lib/guard/blockedEvents.ts";
import type { TelemetryEvent } from "../lib/guard/telemetry.ts";

export function BlockedEventBadge({ events }: { events: readonly TelemetryEvent[] }) {
  // One announcer for the panel's lifetime: rebuilding it would empty the
  // remembered identities and re-count every event in the feed.
  const announcer = useMemo(() => createBlockedBatchAnnouncer(), []);

  useEffect(() => {
    // Feeds the store, which notifies the subscription below. The store is the
    // state here, so this is not a copy of it being written back into React.
    announcer.observe(events);
  }, [announcer, events]);

  useEffect(() => () => announcer.dispose(), [announcer]);

  const pending = useSyncExternalStore(
    announcer.subscribe,
    announcer.getPending,
    announcer.getPending,
  );

  if (pending === 0) return null;
  return (
    <span className="pill danger" data-testid="blocked-count">
      {blockedBatchMessage(pending)}
    </span>
  );
}
