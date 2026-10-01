"use client";

import { useMemo } from "react";
import type { PolicyConfig } from "stellar-agent-guard-sdk";
import { simulatePolicy } from "../lib/guard/policySimulator";
import { useGuardEvents } from "./GuardProvider.tsx";

/**
 * Rolling spend window projection (issue #76).
 *
 * Replays the telemetry the guard actually recorded against the candidate
 * policy the form is proposing and visualizes the verdicts: the rolling-window
 * spend curve against the proposed ceiling, markers where historical calls
 * would have been refused or throttled, and the approval summary. All the
 * judgment lives in `policySimulator.ts`; this component only projects it.
 */

const WIDTH = 420;
const HEIGHT = 220;
const PADDING = 44;
const PLOT_HEIGHT = HEIGHT - 2 * PADDING;

interface Props {
  /** Candidate policy to simulate. `null` while the form has no valid draft yet. */
  policy?: PolicyConfig | null;
}

export function PolicySimulationView({ policy = null }: Props) {
  const events = useGuardEvents();
  const simulation = useMemo(
    () => (policy ? simulatePolicy(events, policy) : null),
    [events, policy],
  );

  if (!policy || !simulation) {
    return (
      <div style={{ marginTop: 14 }}>
        <h3>Rolling spend simulation</h3>
        <p className="tiny muted">
          Fix the policy fields below to simulate them against the guard&apos;s recent activity.
        </p>
      </div>
    );
  }

  const ceiling = policy.window_cap > 0n ? policy.window_cap : null;
  const perTxCap = policy.per_tx_cap > 0n ? policy.per_tx_cap : null;

  // With no judged events there is no curve to place; the (degenerate) scale
  // still renders axes and cap lines without reading the wall clock in render.
  const times = simulation.curve.map((point) => point.time);
  const maxTime = times.length > 0 ? Math.max(...times) : 0;
  const minTime = times.length > 0 ? Math.min(...times) : 0;
  const span = Math.max(maxTime - minTime, 1);

  const maxSpend = simulation.curve.reduce(
    (max, point) => (point.spendStroops > max ? point.spendStroops : max),
    0n,
  );
  const yMax = [ceiling ?? 0n, perTxCap ?? 0n, maxSpend, 1n].reduce((a, b) => (b > a ? b : a));

  const toX = (time: number) => PADDING + ((time - minTime) / span) * (WIDTH - 2 * PADDING);
  // BigInt math keeps i128-sized caps from overflowing the pixel projection.
  const toY = (value: bigint) => HEIGHT - PADDING - Number((value * BigInt(PLOT_HEIGHT)) / yMax);

  const pathD = simulation.curve
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${toX(point.time).toFixed(1)},${toY(point.spendStroops).toFixed(1)}`,
    )
    .join(" ");

  // Markers walk the curve in lockstep with the judged events: the simulator
  // emits one curve point per judged event, in input order.
  let cursor = 0;
  const markers = simulation.events.flatMap((entry) => {
    const point = simulation.curve[cursor++];
    if (!point || entry.outcome === "approved" || entry.outcome === "unjudged") return [];
    return [{ time: point.time, spend: point.spendStroops, outcome: entry.outcome }];
  });

  return (
    <div style={{ marginTop: 14 }}>
      <h3>Rolling 24h spend simulation</h3>
      <svg
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label="Rolling spend curve versus the proposed policy ceiling, with refused calls marked"
      >
        {/* Axes */}
        <line x1={PADDING} y1={PADDING} x2={PADDING} y2={HEIGHT - PADDING} stroke="#888" />
        <line
          x1={PADDING}
          y1={HEIGHT - PADDING}
          x2={WIDTH - PADDING}
          y2={HEIGHT - PADDING}
          stroke="#888"
        />

        {/* Proposed rolling-window spend ceiling */}
        {ceiling !== null && (
          <>
            <line
              x1={PADDING}
              y1={toY(ceiling)}
              x2={WIDTH - PADDING}
              y2={toY(ceiling)}
              stroke="red"
              strokeDasharray="4 2"
              strokeWidth={1.5}
            />
            <text x={PADDING + 4} y={toY(ceiling) - 4} fontSize={10} fill="red">
              Window cap: {ceiling.toLocaleString()} stroops
            </text>
          </>
        )}

        {/* Proposed per-transaction cap */}
        {perTxCap !== null && (
          <>
            <line
              x1={PADDING}
              y1={toY(perTxCap)}
              x2={WIDTH - PADDING}
              y2={toY(perTxCap)}
              stroke="#e08a00"
              strokeDasharray="2 3"
              strokeWidth={1}
            />
            <text x={PADDING + 4} y={toY(perTxCap) - 4} fontSize={10} fill="#e08a00">
              Per-tx cap: {perTxCap.toLocaleString()} stroops
            </text>
          </>
        )}

        {/* Rolling-window spend curve */}
        {pathD !== "" && <path d={pathD} fill="none" stroke="#4f8ef7" strokeWidth={2} />}

        {/* Calls the candidate policy would have refused or throttled */}
        {markers.map((marker, index) => (
          <circle
            key={index}
            cx={toX(marker.time)}
            cy={toY(marker.spend)}
            r={4}
            fill={marker.outcome === "rejected" ? "red" : "#e08a00"}
            opacity={0.75}
          />
        ))}
      </svg>
      <div>
        <small>
          {simulation.summary}
          {simulation.judged === 0 && (
            <span className="tiny muted">
              {" "}
              — no auth decisions in the recent telemetry to replay.
            </span>
          )}
        </small>
      </div>
      <div>
        <small className="tiny muted">
          Approved {simulation.approved} · throttled {simulation.throttled} · refused{" "}
          {simulation.rejected} · unjudged {simulation.total - simulation.judged}
        </small>
      </div>
    </div>
  );
}
