/**
 * Client-side replay of telemetry against a candidate policy (issue #76).
 *
 * Before an operator installs a new `PolicyConfig`, they want to know how it
 * would have treated the activity the guard actually saw. This module replays
 * the last N telemetry events against that candidate policy — no chain calls,
 * no writes — and classifies each `auth_checked` event:
 *
 *   - `approved` — the policy would have allowed the call as-is.
 *   - `throttled` — the call fits the per-transaction cap but lands on a
 *     rolling-window spend that is already at or above the window cap, so the
 *     contract would refuse it until the window drains.
 *   - `rejected` — the policy refuses the call outright: it is paused, outside
 *     its active window, or the amount alone exceeds the per-transaction cap.
 *
 * This mirrors the order the contract checks in (`validate_config` /
 * `event_auth_checked` semantics: pause and lifetime first, then per-transfer
 * cap, then the rolling window), so a simulated verdict is a good predictor of
 * the on-chain one for the inputs telemetry can express. What telemetry cannot
 * express — which protocol function was called, which asset was moved — is not
 * judged at all rather than guessed, and shows up as unjudged events.
 *
 * Amounts stay `bigint` end to end: caps are i128 on chain and narrowing them
 * to `number` would lose precision on exactly the values a spend cap compares.
 */

import type { PolicyConfig } from "stellar-agent-guard-sdk";
import type { TelemetryEvent } from "./telemetry.ts";

/** How the candidate policy would have treated one historical call. */
export type SimulationOutcome = "approved" | "throttled" | "rejected";

/** Reasons a call was rejected outright. */
export type SimulationRejectionReason =
  | "policy_paused"
  | "policy_not_active"
  | "per_tx_cap";

/** Reasons a call was throttled (retryable, time-dependent). */
export type SimulationThrottleReason = "window_cap_exceeded";

/** One judged (or explicitly unjudged) historical call. */
export interface SimulatedEvent {
  /** Millisecond epoch the call happened at (diagnostics may only carry an observed-at time). */
  time: number | null;
  /** Transfer amount in stroops; `null` when telemetry did not record one. */
  amountStroops: bigint | null;
  outcome: SimulationOutcome | "unjudged";
  /** Machine-readable reason for a non-approved outcome, if there is one. */
  reason: SimulationRejectionReason | SimulationThrottleReason | null;
  /** The reason string the chain itself reported, when replaying a blocked diagnostic. */
  chainReason: string | null;
  /** Ledger sequence, when the event was committed. */
  ledger: number | null;
}

/** A point on the rolling spend curve the chart draws. */
export interface SpendCurvePoint {
  /** Millisecond epoch. */
  time: number;
  /** Cumulative spend inside the rolling window, in stroops. */
  spendStroops: bigint;
}

export interface SimulationResult {
  /** Events considered (all inputs, including unjudgeable ones). */
  total: number;
  /** Events that carried a decision telemetry could judge. */
  judged: number;
  approved: number;
  throttled: number;
  rejected: number;
  /** Per-event verdicts, aligned with the input order. */
  events: SimulatedEvent[];
  /** Spend curve across judged calls, in time order. */
  curve: SpendCurvePoint[];
  /** Total spend inside the most recent window length, in stroops. */
  windowSpendStroops: bigint;
  /** `approved / judged` as a percentage, `null` when nothing was judged. */
  approvalRate: number | null;
  /** Human summary, e.g. "Would have approved 94% of historical calls (6 blocked due to per-tx cap)". */
  summary: string;
}

export interface SimulationOptions {
  /**
   * "Now" for active-window and rolling-window math, in ms. Defaults to the
   * wall clock; tests pass a fixed time to be deterministic.
   */
  now?: number;
}

const MS_PER_SEC = 1_000n;

/** Pull the transfer amount (stroops) out of an auth event's data, if present. */
function eventAmount(event: TelemetryEvent): bigint | null {
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const record = (data as { record?: unknown }).record;
  if (typeof record !== "object" || record === null) return null;
  const raw = (record as { amount?: unknown }).amount;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return BigInt(Math.trunc(raw));
  // String form arrives from decoders that preserve i128 textually.
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  return null;
}

/** Millisecond timestamp of an event, falling back to when this console saw it. */
function eventTime(event: TelemetryEvent): number | null {
  if (event.ledgerClosedAt) {
    const parsed = Date.parse(event.ledgerClosedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (event.observedAt) {
    const parsed = Date.parse(event.observedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isJudgeable(event: TelemetryEvent): boolean {
  return event.kind === "auth_checked" && eventAmount(event) !== null;
}

/**
 * Replay telemetry events against a candidate `PolicyConfig`.
 *
 * Never talks to the chain and never throws on odd input: events that do not
 * carry a judgeable decision (heartbeats, admin events, auth events without a
 * recorded amount) are passed through as `unjudged`.
 */
export function simulatePolicy(
  events: readonly TelemetryEvent[],
  policy: PolicyConfig,
  options: SimulationOptions = {},
): SimulationResult {
  const now = options.now ?? Date.now();
  const windowMs = policy.window_secs > 0n ? policy.window_secs * MS_PER_SEC : 0n;
  const perTxCap = policy.per_tx_cap;
  const windowCap = policy.window_cap;

  // The active window bounds come from the policy; convert the unix-second
  // bounds to ms once. A zero bound means "no bound on this side".
  const activeFromMs = policy.active_from > 0n ? policy.active_from * MS_PER_SEC : null;
  const activeUntilMs = policy.active_until > 0n ? policy.active_until * MS_PER_SEC : null;

  const simulated: SimulatedEvent[] = [];
  const curve: SpendCurvePoint[] = [];

  // Sliding window of (time, amount) for judged calls, kept in arrival order —
  // telemetry is appended in ledger order, and equal timestamps accumulate.
  const window: Array<{ time: number; amount: bigint }> = [];
  let windowSpend = 0n;

  for (const event of events) {
    const time = eventTime(event);
    const amount = eventAmount(event);

    if (!isJudgeable(event) || amount === null) {
      simulated.push({
        time,
        amountStroops: amount,
        outcome: "unjudged",
        reason: null,
        chainReason: event.decision?.reason ?? null,
        ledger: event.ledger,
      });
      continue;
    }

    const judgedAt = time ?? now;

    // Drain spend that has left the rolling window before evaluating this call.
    if (windowMs > 0n) {
      const windowStart = judgedAt - Number(windowMs);
      for (;;) {
        const oldest = window[0];
        if (oldest === undefined || oldest.time > windowStart) break;
        windowSpend -= oldest.amount;
        window.shift();
      }
    }

    let outcome: SimulationOutcome;
    let reason: SimulationRejectionReason | SimulationThrottleReason | null = null;

    if (policy.paused) {
      outcome = "rejected";
      reason = "policy_paused";
    } else if (
      (activeFromMs !== null && judgedAt < activeFromMs) ||
      (activeUntilMs !== null && judgedAt >= activeUntilMs)
    ) {
      outcome = "rejected";
      reason = "policy_not_active";
    } else if (perTxCap > 0n && amount > perTxCap) {
      outcome = "rejected";
      reason = "per_tx_cap";
    } else if (windowCap > 0n && windowSpend + amount > windowCap) {
      outcome = "throttled";
      reason = "window_cap_exceeded";
    } else {
      outcome = "approved";
    }

    // The rolling window tracks what the policy would have accepted into its
    // own accounting. Throttled calls never landed on chain, so they add no
    // spend — replaying them as spend would compound refusals that a real
    // retry after the window drains would not hit.
    if (outcome === "approved") {
      window.push({ time: judgedAt, amount });
      windowSpend += amount;
    }

    curve.push({ time: judgedAt, spendStroops: windowSpend });

    simulated.push({
      time,
      amountStroops: amount,
      outcome,
      reason,
      chainReason: event.decision?.reason ?? null,
      ledger: event.ledger,
    });
  }

  const approved = simulated.filter((entry) => entry.outcome === "approved").length;
  const throttled = simulated.filter((entry) => entry.outcome === "throttled").length;
  const rejected = simulated.filter((entry) => entry.outcome === "rejected").length;
  const judged = approved + throttled + rejected;

  const approvalRate = judged > 0 ? Math.round((approved / judged) * 100) : null;

  const perTxCapBlocks = simulated.filter((entry) => entry.reason === "per_tx_cap").length;
  const otherBlocks = rejected - perTxCapBlocks;
  const summary = summarize(approvalRate, judged, perTxCapBlocks, otherBlocks, throttled);

  return {
    total: events.length,
    judged,
    approved,
    throttled,
    rejected,
    events: simulated,
    curve,
    windowSpendStroops: windowSpend,
    approvalRate,
    summary,
  };
}

/** Build the issue's summary sentence, e.g. "Would have approved 94% of historical calls (6 blocked due to per-tx cap)". */
function summarize(
  approvalRate: number | null,
  judged: number,
  perTxCapBlocks: number,
  otherBlocks: number,
  throttled: number,
): string {
  if (approvalRate === null || judged === 0) {
    return "No historical calls to simulate — no auth decisions in the selected telemetry";
  }
  const notes: string[] = [];
  if (perTxCapBlocks > 0) notes.push(`${perTxCapBlocks} blocked due to per-tx cap`);
  if (otherBlocks > 0) notes.push(`${otherBlocks} refused while paused or outside the active window`);
  if (throttled > 0) notes.push(`${throttled} throttled by the rolling window`);
  const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  return `Would have approved ${approvalRate}% of historical calls${suffix}`;
}
