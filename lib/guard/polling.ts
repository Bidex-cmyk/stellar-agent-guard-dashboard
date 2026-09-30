/**
 * Every poll cadence in the dashboard, in one place.
 *
 * Before this module, the intervals lived as separate literals beside the code
 * that polled: `SNAPSHOT_INTERVAL_MS = 15_000` and `FEED_INTERVAL_MS = 5_000`
 * atop `components/GuardProvider.tsx`, and a bare `5000` inside
 * `components/FleetTable.tsx`. Values that scattered drift apart silently, so
 * they now live here as one object. Centralization is the whole change: the
 * values themselves are the ones the code already used, preserved per site
 * (see each field's comment for the rationale). Retuning a cadence is a
 * separate decision that needs a measured problem first; none was measured.
 *
 * Why jitter at all, on a dashboard? The SDK's telemetry listener added full
 * jitter to its poll loop for fleet reasons (stellar-agent-guard-sdk issue #71,
 * `computePollDelay` in its `src/telemetry.ts`): agents derived from identical
 * templates poll in lockstep phase and stampede the shared RPC endpoint. A
 * dashboard is one operator, not a fleet — but the same reasoning applies
 * adapted: the console is routinely open in several tabs at once (each tab
 * runs its own pollers, against the *same* public RPC endpoint the guards and
 * agents use), and two tabs opened from the same bookmark poll in lockstep
 * exactly like a two-agent fleet. The cost of jitter is bounded randomness in
 * the refresh time (±20%); the cost of lockstep is contributing to the herd
 * the SDK issue exists to break. Default is therefore jitter on; `jitter:
 * "none"` restores the exact fixed cadence.
 *
 * The config is a plain module constant, read at mount: changing a cadence
 * means a reload, not a live-wired setting. A config UI is explicitly out of
 * scope (issue #56).
 */

/**
 * The poll cadences, in milliseconds.
 *
 * `statusMs` and `balanceMs` are the same loop on purpose: the snapshot poll
 * reads status, policy, the rolling-spend window and the balance in one pass
 * (SPEC.md §8, "mount + poll"), so there is no separate balance timer to
 * configure. The two keys name the two concerns so a future change to one can
 * be argued without pretending the other moves with it.
 */
export const DEFAULT_POLL_CADENCE = {
  /** Status/policy/spend snapshot poll (was `SNAPSHOT_INTERVAL_MS`). 15s keeps operator-fresh numbers without doubling the read-only `simulateTransaction` load every few seconds. */
  statusMs: 15_000,
  /** Balance, read inside the snapshot loop (was the same 15s timer; key exists so the concern is nameable). */
  balanceMs: 15_000,
  /** Telemetry event-feed poll (was `FEED_INTERVAL_MS`). 5s ≈ the ~5s ledger close time (`AVERAGE_LEDGER_CLOSE_SECS` in `ledgerTime.ts`) — polling faster than the chain closes ledgers buys nothing. */
  feedMs: 5_000,
  /** Fleet-overview poll (was a bare `5000` in `FleetTable`). Mirrors the feed: one fleet row is one guard's snapshot read. */
  fleetMs: 5_000,
} as const;

export type PollCadence = typeof DEFAULT_POLL_CADENCE;

/**
 * Jitter mode for a poll loop, mirroring the SDK's `TelemetryJitter`:
 * - `"full"` (default): each delay is uniform in `[interval * (1 - j), interval]`.
 * - `"none"`: exact fixed interval (the pre-jitter behaviour).
 */
export type PollJitter = "none" | "full";

/** The jitter fraction `j`, shared with the SDK's documented default (`DEFAULT_JITTER_FRACTION` in its `src/telemetry.ts`, from SDK issue #71). */
export const DEFAULT_JITTER_FRACTION = 0.2;

/**
 * Compute one poll delay with optional full jitter — the SDK's formula,
 * reproduced locally because the vendored SDK tarball (v0.1.0) predates its
 * export. When the dashboard consumes a published SDK that ships
 * `computePollDelay`, this function should be replaced by an import of it
 * (the constants and tests here already match its shape and fraction).
 *
 * `jitter: "full"` distributes the delay uniformly in
 * `[intervalMs * (1 - j), intervalMs]` with `j = 0.2`; `jitter: "none"`
 * returns `intervalMs` unchanged. `jitterFraction` is clamped to `[0, 1]`
 * so a bad constant degrades to a bounded delay, never a negative or NaN one.
 * `rng` is injected so tests are deterministic.
 */
export function computePollDelay(
  intervalMs: number,
  jitter: PollJitter = "full",
  rng: () => number = Math.random,
  jitterFraction: number = DEFAULT_JITTER_FRACTION,
): number {
  if (jitter === "none") return intervalMs;
  const j = Math.max(0, Math.min(1, jitterFraction));
  const factor = 1 - j + rng() * j;
  return Math.round(intervalMs * factor);
}

/**
 * Run `tick` on a repeating, jittered schedule; return the stop function.
 *
 * This replaces the call sites' `setInterval(tick, ms)` so every loop gets the
 * jitter by default. Timer semantics are otherwise the parity the call sites
 * already had: each round's delay is computed right after the previous `tick`
 * returns, and — the reason this helper exists — every delay, including the
 * first, is jittered. Tabs opened from the same bookmark start in phase,
 * which is precisely the herd this exists to break.
 */
export function startPollingLoop(
  intervalMs: number,
  tick: () => void,
  jitter: PollJitter = "full",
  rng: () => number = Math.random,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      tick();
      schedule();
    }, computePollDelay(intervalMs, jitter, rng));
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
