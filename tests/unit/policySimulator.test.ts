import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuardAuthDecision, PolicyConfig } from "stellar-agent-guard-sdk";
import { simulatePolicy, type SimulatedEvent } from "../../lib/guard/policySimulator.ts";
import type { TelemetryEvent } from "../../lib/guard/telemetry.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const HOUR_MS = 3_600_000;

/** Monotonic filler for the SDK-required `id`; the simulator never reads it. */
let sequence = 0;

/** A permissive policy: nothing blocks, so only amounts and windows matter. */
function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 0n,
    window_secs: 86_400n,
    window_cap: 0n,
    assets: [],
    protocols: [],
    recipients: [],
    allow_any_recipient: true,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
    ...overrides,
  };
}

/** A minimal judgeable auth event: an `auth_checked` decision with an amount. */
function authEvent(
  overrides: {
    time?: number;
    amount?: bigint | number | string;
    decision?: "allowed" | "blocked";
    reason?: GuardAuthDecision["reason"];
    ledger?: number;
  } = {},
): TelemetryEvent {
  const { time = NOW, amount = 100n, ...rest } = overrides;
  return {
    id: `sim:auth:${sequence++}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    stream: "committed",
    contractId: "CTEST",
    ledger: rest.ledger ?? null,
    ledgerClosedAt: new Date(time).toISOString(),
    observedAt: null,
    transactionHash: null,
    decision: {
      result: rest.decision ?? "allowed",
      reason: rest.reason ?? null,
      source: "ledger",
    },
    data: { record: { amount } },
  };
}

/** A non-auth event (heartbeat / admin) — never judgeable. */
function otherEvent(kind: TelemetryEvent["kind"], time = NOW): TelemetryEvent {
  return {
    id: `sim:${kind}:${sequence++}`,
    kind,
    topic: `event_${kind}`,
    source: "ledger",
    stream: "committed",
    contractId: "CTEST",
    ledger: null,
    ledgerClosedAt: new Date(time).toISOString(),
    observedAt: null,
    transactionHash: null,
    decision: null,
    data: {},
  };
}

function outcomes(events: readonly TelemetryEvent[], config: PolicyConfig): string[] {
  return simulatePolicy(events, config, { now: NOW }).events.map((entry) => entry.outcome);
}

test("approves every judged call under a permissive policy", () => {
  const result = simulatePolicy(
    [authEvent({ amount: 1n }), authEvent({ amount: 999n }), authEvent({ amount: 100_000n })],
    policy(),
    { now: NOW },
  );

  assert.equal(result.judged, 3);
  assert.equal(result.approved, 3);
  assert.equal(result.throttled, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.approvalRate, 100);
  assert.match(result.summary, /Would have approved 100% of historical calls/);
});

test("rejects a call above the per-transaction cap and reports it in the summary", () => {
  const result = simulatePolicy(
    [authEvent({ amount: 50n }), authEvent({ amount: 5_000n })],
    policy({ per_tx_cap: 1_000n }),
    { now: NOW },
  );

  assert.equal(result.approved, 1);
  assert.equal(result.rejected, 1);
  const rejected = result.events[1] as SimulatedEvent;
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.reason, "per_tx_cap");
  assert.match(result.summary, /1 blocked due to per-tx cap/);
});

test("throttles a call that would exceed the rolling-window cap", () => {
  // Window cap 300; two calls of 200 each inside the window: second throttles.
  const result = simulatePolicy(
    [authEvent({ time: NOW - 1_000, amount: 200n }), authEvent({ time: NOW, amount: 200n })],
    policy({ window_secs: 3_600n, window_cap: 300n }),
    { now: NOW },
  );

  assert.equal(result.approved, 1);
  assert.equal(result.throttled, 1);
  const throttled = result.events[1] as SimulatedEvent;
  assert.equal(throttled.outcome, "throttled");
  assert.equal(throttled.reason, "window_cap_exceeded");
  assert.match(result.summary, /1 throttled by the rolling window/);
});

test("the rolling window drains: an old call stops counting against the cap", () => {
  // Window is 1h. A 200 call 2h ago, then a 200 call now, cap 300: the old
  // spend has left the window, so the second call is approved.
  const result = simulatePolicy(
    [authEvent({ time: NOW - 2 * HOUR_MS, amount: 200n }), authEvent({ time: NOW, amount: 200n })],
    policy({ window_secs: 3_600n, window_cap: 300n }),
    { now: NOW },
  );

  assert.equal(result.approved, 2);
  assert.equal(result.throttled, 0);
});

test("rejected and throttled calls do not add spend to the window", () => {
  // Cap 300/window. A 500 call (rejected, no spend), then a 200 call: still
  // fits because the rejected call never contributed.
  const result = simulatePolicy(
    [authEvent({ time: NOW - 1_000, amount: 500n }), authEvent({ time: NOW, amount: 200n })],
    policy({ per_tx_cap: 400n, window_secs: 3_600n, window_cap: 300n }),
    { now: NOW },
  );

  assert.equal(result.rejected, 1);
  assert.equal(result.approved, 1);
});

test("rejects calls while the policy is paused", () => {
  const result = simulatePolicy([authEvent({ amount: 10n })], policy({ paused: true }), {
    now: NOW,
  });

  assert.equal(result.rejected, 1);
  assert.equal((result.events[0] as SimulatedEvent).reason, "policy_paused");
});

test("rejects calls outside the policy's active window", () => {
  const activeFrom = BigInt(Math.floor((NOW + HOUR_MS) / 1000)); // starts in 1h
  const activeUntil = BigInt(Math.floor((NOW + 2 * HOUR_MS) / 1000)); // ends in 2h

  const before = simulatePolicy([authEvent({ time: NOW })], policy({ active_from: activeFrom }), {
    now: NOW,
  });
  assert.equal(before.rejected, 1);
  assert.equal((before.events[0] as SimulatedEvent).reason, "policy_not_active");

  // An event at the active_until boundary is already past the window.
  const after = simulatePolicy(
    [authEvent({ time: NOW + 2 * HOUR_MS })],
    policy({ active_until: activeUntil }),
    { now: NOW },
  );
  assert.equal(after.rejected, 1);
  assert.equal((after.events[0] as SimulatedEvent).reason, "policy_not_active");

  // Midway through the window ([from, until) = [1h, 2h)): approved.
  const inside = simulatePolicy(
    [authEvent({ time: NOW + HOUR_MS + HOUR_MS / 2 })],
    policy({ active_from: activeFrom, active_until: activeUntil }),
    { now: NOW },
  );
  assert.equal(inside.approved, 1);
});

test("passes through non-auth events as unjudged without failing", () => {
  const result = simulatePolicy(
    [otherEvent("heartbeat"), otherEvent("policy_set"), authEvent({ amount: 10n })],
    policy(),
    { now: NOW },
  );

  assert.equal(result.total, 3);
  assert.equal(result.judged, 1);
  assert.equal(result.approved, 1);
  assert.equal(result.events[0]?.outcome, "unjudged");
  assert.equal(result.events[1]?.outcome, "unjudged");
});

test("passes through auth events without a recorded amount as unjudged", () => {
  const event: TelemetryEvent = {
    ...authEvent(),
    data: { record: {} },
  };
  const result = simulatePolicy([event], policy(), { now: NOW });

  assert.equal(result.judged, 0);
  assert.equal(result.events[0]?.outcome, "unjudged");
});

test("accepts numeric and string amounts, treating them as stroops", () => {
  const result = simulatePolicy(
    [authEvent({ amount: 100 }), authEvent({ amount: "250" })],
    policy({ per_tx_cap: 200n }),
    { now: NOW },
  );

  assert.equal(result.approved, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.events[1]?.amountStroops, 250n);
});

test("empty telemetry yields a null approval rate and a no-data summary", () => {
  const result = simulatePolicy([], policy(), { now: NOW });

  assert.equal(result.total, 0);
  assert.equal(result.judged, 0);
  assert.equal(result.approvalRate, null);
  assert.match(result.summary, /No historical calls to simulate/);
});

test("the curve records cumulative window spend at each judged call", () => {
  const result = simulatePolicy(
    [
      authEvent({ time: NOW - 2_000, amount: 100n }),
      authEvent({ time: NOW - 1_000, amount: 100n }),
      authEvent({ time: NOW, amount: 100n }),
    ],
    policy({ window_secs: 3_600n }),
    { now: NOW },
  );

  assert.deepEqual(
    result.curve.map((point) => point.spendStroops),
    [100n, 200n, 300n],
  );
  assert.equal(result.windowSpendStroops, 300n);
});

test("the issue's example: 94% approval with 6 blocked reads correctly", () => {
  // 100 calls, 94 small and approved, 6 over the per-tx cap.
  const events = [
    ...Array.from({ length: 94 }, (_, i) =>
      authEvent({ time: NOW - (100 - i) * 1_000, amount: 10n }),
    ),
    ...Array.from({ length: 6 }, (_, i) => authEvent({ time: NOW - i * 1_000, amount: 9_999n })),
  ];
  const result = simulatePolicy(events, policy({ per_tx_cap: 100n }), { now: NOW });

  assert.equal(result.judged, 100);
  assert.equal(result.approved, 94);
  assert.equal(result.rejected, 6);
  assert.equal(result.approvalRate, 94);
  assert.equal(
    result.summary,
    "Would have approved 94% of historical calls (6 blocked due to per-tx cap)",
  );
});

test("preserves the chain's own reason on replayed blocked diagnostics", () => {
  const event = authEvent({
    decision: "blocked",
    reason: "recipient_not_allowed",
    amount: 10n,
  });
  const result = simulatePolicy([event], policy(), { now: NOW });

  // The candidate policy is permissive, so the simulated verdict is approval —
  // but the original chain reason stays attached for the UI to show.
  assert.equal(result.events[0]?.chainReason, "recipient_not_allowed");
});

test("outcomes stay aligned with input order, unjudged events included", () => {
  const events = [
    otherEvent("heartbeat", NOW - 3_000),
    authEvent({ time: NOW - 2_000, amount: 5_000n }),
    authEvent({ time: NOW - 1_000, amount: 10n }),
    otherEvent("frozen", NOW - 500),
    authEvent({ time: NOW, amount: 10n }),
  ];
  const result = simulatePolicy(events, policy({ per_tx_cap: 100n }), { now: NOW });

  assert.deepEqual(outcomes(events, policy({ per_tx_cap: 100n })), [
    "unjudged",
    "rejected",
    "approved",
    "unjudged",
    "approved",
  ]);
  assert.equal(result.events.length, 5);
});

test("events with no resolvable timestamp fall back to the simulation clock", () => {
  const event: TelemetryEvent = {
    ...authEvent({ amount: 10n }),
    ledgerClosedAt: null,
  };
  const result = simulatePolicy([event], policy(), { now: NOW });

  assert.equal(result.approved, 1);
  assert.equal(result.curve[0]?.time, NOW);
});
