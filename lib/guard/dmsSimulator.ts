/**
 * Incident Simulation Mode: what the dead-man switch looks like when it fires,
 * without waiting for the real timer and without touching the chain.
 *
 * Operators train new team members and rehearse alert escalation against a
 * live-looking console. Rehearsal needs the *shape* of an incident — the grace
 * countdown draining, the switch tripping, the freeze — but rehearsal must
 * never be an incident: every value here is computed locally, nothing in this
 * module performs a read or a write, and the state is fenced behind an
 * explicit opt-in so it cannot silently blend into production reads.
 *
 * The module is a pure function of its inputs. `tick` is injectable so tests
 * pin the clock and step through state transitions deterministically; the UI
 * drives it with the wall clock. Like the rest of `lib/guard`, it is
 * isomorphic and carries no React, no RPC, and no `Buffer`.
 */

import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";

/** The rehearsal scenarios the toggle can walk through. */
export type SimulationScenario = "expiring" | "tripped";

/**
 * The scenario's phase at a moment in time.
 *
 * The phases are deliberately the same words the real panel uses
 * ("within grace" / "expired" / "FIRED") so a trainee's eyes move between the
 * rehearsal and the real panel without relearning anything. `armed` is the
 * pre-run state before the scenario starts.
 */
export type SimulationPhase = "armed" | "within-grace" | "expired" | "fired";

/** Everything the UI needs to render one frame of the simulation. */
export interface SimulationState {
  scenario: SimulationScenario;
  phase: SimulationPhase;
  /** Synthetic seconds of grace left; goes negative after the trip. */
  remaining: number;
  /** 0–100, how much of the synthetic grace has drained. */
  percentElapsed: number;
  /** Seconds since the scenario was armed/started, for the status line. */
  elapsed: number;
}

/** How long the synthetic countdown runs, in seconds of real time. */
export const SIMULATION_GRACE_SECS = 60;

/** How far past the trip the "fired" state settles before the run ends. */
export const FIRED_SETTLE_SECS = 10;

/** Human-readable labels for the scenarios, used by the toggle and tests. */
export const SCENARIO_LABELS: Record<SimulationScenario, string> = {
  expiring: "DMS expiring — grace draining to zero",
  tripped: "DMS tripped — account frozen by silence",
};

/** Human-readable phase labels matching the real panel's vocabulary. */
export const PHASE_LABELS: Record<SimulationPhase, string> = {
  armed: "rehearsal armed",
  "within-grace": "within grace",
  expired: "grace elapsed; account refuses calls",
  fired: "FIRED — frozen by silence",
};

/**
 * The moment a scenario starts: the state at `tick` when the run begins.
 *
 * `startedAt` is when the operator pressed the button; the countdown drains
 * from `SIMULATION_GRACE_SECS` at one synthetic second per real second.
 */
export function armScenario(scenario: SimulationScenario, startedAt: number): SimulationState {
  return {
    scenario,
    phase: "within-grace",
    remaining: SIMULATION_GRACE_SECS,
    percentElapsed: 0,
    elapsed: 0,
  };
}

/**
 * Advance the simulation to `tick` (a Unix millisecond timestamp), given when
 * the run started. Pure: the same inputs always produce the same state.
 *
 * The "expiring" scenario walks the full lifecycle — grace draining, hitting
 * zero (expired), settling into fired. The "tripped" scenario starts already
 * past the trip, so trainees see the end state and the alert that would fire
 * without watching the drain.
 */
export function tickScenario(
  scenario: SimulationScenario,
  startedAt: number,
  tick: number,
): SimulationState {
  const elapsed = Math.max(0, (tick - startedAt) / 1000);

  if (scenario === "tripped") {
    // Already past the trip: show the settled post-incident state.
    const remaining = -Math.min(FIRED_SETTLE_SECS, Math.max(0, elapsed));
    return {
      scenario,
      phase: "fired",
      remaining,
      percentElapsed: 100,
      elapsed,
    };
  }

  // "expiring": one synthetic second of grace per real second. The countdown
  // bottoms out at the settle bound so a panel left open overnight does not
  // keep a number growing forever.
  const remaining = Math.max(-FIRED_SETTLE_SECS, SIMULATION_GRACE_SECS - elapsed);
  const percentElapsed = Math.min(100, Math.max(0, (elapsed / SIMULATION_GRACE_SECS) * 100));
  const phase: SimulationPhase =
    remaining <= -FIRED_SETTLE_SECS ? "fired" : remaining <= 0 ? "expired" : "within-grace";
  return { scenario, phase, remaining, percentElapsed, elapsed };
}

/** The synthetic `last_heartbeat` the simulated state reports. */
export function simulatedHeartbeat(nowSecs: bigint, state: SimulationState): bigint {
  // The story the timeline tells: the agent beat exactly when the scenario
  // armed, then went silent. Silence age is the drained grace, capped at the
  // full window — once the switch has fired the beat stops getting older,
  // because the account froze; time did not keep counting on the ledger.
  const silenceAge = Math.min(
    SIMULATION_GRACE_SECS,
    Math.max(0, SIMULATION_GRACE_SECS - state.remaining),
  );
  return nowSecs - BigInt(Math.round(silenceAge));
}

/**
 * A synthetic `GuardStatus` consistent with the simulation's phase.
 *
 * Only the two DMS fields and `now` move; `has_policy` and `admin_frozen` are
 * copied from the real read so the panel keeps rendering the operator's
 * actual policy context underneath the rehearsal. This is what makes the
 * result realistic without it being real: the fields a trainee is studying
 * (heartbeat_expired, the countdown) are synthetic, the rest is live.
 */
export function simulatedStatus(real: GuardStatus, state: SimulationState): GuardStatus {
  const now = real.now;
  const heartbeat = simulatedHeartbeat(now, state);
  const expired = state.phase === "expired" || state.phase === "fired";
  return {
    ...real,
    last_heartbeat: heartbeat,
    heartbeat_expired: expired,
    // The simulator never simulates an admin freeze: that path has its own
    // button, and confusing the two in a rehearsal would train the wrong
    // response.
    admin_frozen: real.admin_frozen,
  };
}

/** The policy side of the rehearsal: unchanged, `null` stays `null`. */
export function simulatedPolicy(policy: PolicyConfig | null): PolicyConfig | null {
  return policy;
}

/** One-line explanation of what the panel is currently showing, for the banner. */
export function describeSimulation(state: SimulationState): string {
  if (state.scenario === "tripped") {
    return `Simulation: the dead-man switch has FIRED. Every call is refused until a heartbeat resumes or an admin unfreezes. (${PHASE_LABELS.fired})`;
  }
  switch (state.phase) {
    case "within-grace":
      return `Simulation: grace is draining — ${Math.max(0, Math.ceil(state.remaining))}s left before the switch fires.`;
    case "expired":
      return "Simulation: grace is exhausted — the account now refuses calls.";
    case "fired":
      return "Simulation: the dead-man switch has FIRED. Every call is refused until a heartbeat resumes or an admin unfreezes.";
    default:
      return "Simulation armed.";
  }
}

/**
 * The alert an on-call would receive at this phase, for escalation rehearsal.
 *
 * This is a *description* of the synthetic alert, not a notification: the
 * simulator never calls webhooks, pagers, or the network.
 */
export function simulatedAlert(state: SimulationState): {
  severity: "warn" | "danger";
  message: string;
} {
  if (state.phase === "within-grace") {
    return {
      severity: "warn",
      message: `HEARTBEAT STALE (simulated) — agent silent ${Math.max(0, Math.round(state.elapsed))}s, ${Math.max(0, Math.ceil(state.remaining))}s of grace left.`,
    };
  }
  return {
    severity: "danger",
    message:
      "DMS FIRED (simulated) — the dead-man switch froze the account after the grace window elapsed. On-call: send a heartbeat to resume, or unfreeze manually.",
  };
}
