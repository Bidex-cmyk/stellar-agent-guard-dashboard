/**
 * Blocked decisions, counted from the event stream and announced in batches.
 *
 * The feed polls `getEvents` every five seconds and prepends whatever arrived, so
 * a burst of refusals is a single poll that adds a dozen rows. Announcing each
 * row would be a firehose: the operator would have to listen to a dozen
 * utterances to learn the one fact that matters — how many calls were refused.
 * So the count is what gets announced, once per batch, and the batch is closed
 * on a fixed window anchored to the *first* event of the batch. A sliding
 * window would never close under a steady stream; a fixed one always does.
 *
 * Two properties this module exists to guarantee:
 *
 *   1. The count comes from the event list, never from rendered rows. The feed's
 *      buffer is a window over the stream — a paused table, a filter, a
 *      historical query or a virtualized list can each mean a blocked event is
 *      in the data and absent from the DOM. Counting what is on screen would
 *      report a number the operator cannot reconcile with the event stream.
 *   2. Every blocked event is counted once. Identities are remembered in a
 *      bounded set, so a re-polled page, a resumed queue or a re-render cannot
 *      double-count an event the operator has already been told about.
 *
 * The window, the clock and the timer are all injected, so the batching is
 * asserted against a fake clock rather than against the speed of the machine
 * running the tests.
 */

import { eventKey, type TelemetryEvent } from "./telemetry.ts";
import { announce } from "./useAnnounce.ts";
import type { AnnounceSink } from "./statusTransitions.ts";

/**
 * How long a batch collects before it is spoken.
 *
 * Comfortably longer than a poll's worth of same-instant refusals, and short
 * enough that an operator is not waiting on a wall of stale counts: it is five
 * times the announcer's own 60ms speak delay plus its 400ms per-message gap, so
 * one batch is always one utterance.
 */
export const BLOCKED_BATCH_WINDOW_MS = 2_000;

/**
 * How many event identities to remember.
 *
 * The feed itself caps at `STREAM_BUFFER_LIMIT` rows and a historical query can
 * hold a few thousand; the bound is what keeps a long session from growing this
 * set for the lifetime of the tab. Oldest identities are dropped first, which can
 * only re-count an event that has already scrolled out of the buffer and is
 * re-delivered.
 */
export const BLOCKED_BATCH_MEMORY = 20_000;

/** The message a batch of `count` refusals is announced as. */
export function blockedBatchMessage(count: number): string {
  return count === 1 ? "1 new blocked event" : `${count} new blocked events`;
}

/**
 * The blocked decisions in `events` that `seen` has not accounted for yet.
 *
 * Pure, and the only place the count is computed: the announcer calls it, and so
 * does the test that proves the count comes from the data rather than the DOM.
 * `count` is a plain integer — there is no timestamp arithmetic here, so there is
 * nothing for a float to round.
 */
export function countNewBlockedEvents(
  events: readonly TelemetryEvent[],
  seen: ReadonlySet<string>,
): number {
  let count = 0;
  for (const event of events) {
    if (seen.has(eventKey(event))) continue;
    if (event.decision?.result === "blocked") count += 1;
  }
  return count;
}

export interface BlockedBatchTimers {
  /** Run `callback` after `delayMs`; the returned function cancels it. */
  schedule(callback: () => void, delayMs: number): () => void;
}

export const realTimers: BlockedBatchTimers = {
  schedule(callback: () => void, delayMs: number): () => void {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export interface BlockedBatchOptions {
  emit?: AnnounceSink;
  windowMs?: number;
  now?: () => number;
  timers?: BlockedBatchTimers;
  memoryLimit?: number;
}

export interface BlockedBatchAnnouncer {
  /**
   * Account for `events`, queue any newly blocked ones, and return how many are
   * waiting to be announced.
   *
   * Idempotent for an unchanged event list: identities are remembered as they
   * are counted, so calling it again with the same events adds nothing. That is
   * what makes it safe to call from render, from an effect, or twice over.
   */
  observe(events: readonly TelemetryEvent[]): number;
  /** Announce the pending batch now, if there is one. */
  flush(): void;
  /** Cancel the pending flush. The remembered identities are kept. */
  dispose(): void;
  /**
   * The pending count, as an external store's snapshot.
   *
   * A plain number and a stable identity while it does not change, which is what
   * `useSyncExternalStore` needs to avoid an infinite render loop.
   */
  getPending(): number;
  /** Observe the count. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function createBlockedBatchAnnouncer(
  options: BlockedBatchOptions = {},
): BlockedBatchAnnouncer {
  const emit = options.emit ?? announce;
  const timers = options.timers ?? realTimers;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? BLOCKED_BATCH_WINDOW_MS;
  const memoryLimit = options.memoryLimit ?? BLOCKED_BATCH_MEMORY;

  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  let pending = 0;
  /** When the current batch opened: the window is anchored to its first event. */
  let startedAt = 0;
  let cancelFlush: (() => void) | null = null;

  /**
   * Move the count and tell whoever is reading it.
   *
   * The badge subscribes to this rather than being handed the number, so the
   * count is never mirrored into React state that can disagree with the
   * announcer's own bookkeeping — the badge cannot show a stale count for one
   * render after a flush, which is exactly when the operator is looking at it.
   */
  function setPending(next: number): void {
    if (next === pending) return;
    pending = next;
    for (const listener of [...listeners]) listener();
  }

  function remember(event: TelemetryEvent): void {
    const key = eventKey(event);
    if (seen.has(key)) return;
    seen.add(key);
    // Set iteration order is insertion order, so the oldest identities are the
    // first ones — exactly the ones worth forgetting.
    while (seen.size > memoryLimit) {
      const oldest = seen.values().next();
      if (oldest.done === true) break;
      seen.delete(oldest.value);
    }
  }

  /**
   * Speak the pending batch, plus `extra` events that arrived as it was closing.
   *
   * `extra` exists for the throttled-tab path below, where the batch is already
   * stale by the time anyone looks at it. Folding the new arrivals into the
   * same utterance is what the operator wants — the number of refusals they have
   * not heard about — rather than a backlog count followed immediately by a
   * second, more recent count for the same wake-up.
   */
  function flush(extra = 0): void {
    cancelFlush?.();
    cancelFlush = null;
    const count = pending + extra;
    if (count === 0) {
      startedAt = 0;
      return;
    }
    setPending(0);
    startedAt = 0;
    // A refused call is the security event the assertive region is for, and this
    // is one utterance per batch rather than one per row.
    emit(blockedBatchMessage(count), "assertive");
  }

  return {
    observe(events: readonly TelemetryEvent[]): number {
      const at = now();
      // Count before remembering: an event is "new" exactly while it is still
      // uncounted, and the two passes below are the only place that ordering is
      // known.
      const fresh = countNewBlockedEvents(events, seen);
      for (const event of events) remember(event);

      if (pending > 0 && at - startedAt >= windowMs) {
        // The window already closed while nothing new arrived — a backgrounded
        // tab is allowed to defer its timers indefinitely, and an operator coming
        // back to the tab should hear the backlog rather than wait for a timer
        // that may not be running. Whatever arrived alongside the wake-up is
        // counted into the same utterance, so nothing is dropped between the
        // stale batch and the next window.
        flush(fresh);
        return 0;
      }
      if (fresh === 0) return pending;

      if (pending === 0) startedAt = at;
      setPending(pending + fresh);
      cancelFlush ??= timers.schedule(flush, startedAt + windowMs - at);
      return pending;
    },
    flush,
    dispose(): void {
      cancelFlush?.();
      cancelFlush = null;
      listeners.clear();
    },
    getPending(): number {
      return pending;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
