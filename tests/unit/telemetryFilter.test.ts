import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterEvents, DEFAULT_FILTER, type TelemetryFilter } from "../../lib/guard/telemetry";
import { syntheticDemoEvent, demoEvents } from "../../lib/guard/demoFixtures";

function makeEvent(overrides: Record<string, unknown> = {}): ReturnType<typeof syntheticDemoEvent> {
  return {
    kind: "auth_checked",
    topic: "auth_checked",
    source: "ledger",
    contractId: "CDEMO1234567890ABCDEF1234567890ABCDEF1234",
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    transactionHash: "abc123",
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
    ...overrides,
  } as ReturnType<typeof syntheticDemoEvent>;
}

function getDecisionResult(event: ReturnType<typeof syntheticDemoEvent>): string | null {
  return event.decision !== null ? event.decision.result : null;
}

function getDataAmount(event: ReturnType<typeof syntheticDemoEvent>): bigint | null {
  const d = event.data as Record<string, unknown> | undefined;
  if (d && typeof d.amount === "bigint") return d.amount;
  return null;
}

describe("filterEvents", () => {
  it("returns all events when filter is default", () => {
    const events = [
      makeEvent({ kind: "auth_checked", decision: { result: "allowed", reason: null, source: "ledger" } }),
      makeEvent({ kind: "heartbeat", decision: null }),
      makeEvent({ kind: "frozen", decision: { result: "blocked", reason: "test", source: "ledger" } }),
    ];
    const result = filterEvents(events, DEFAULT_FILTER);
    assert.equal(result.length, 3);
  });

  it("filters to approved-only", () => {
    const events = [
      makeEvent({ decision: { result: "allowed", reason: null, source: "ledger" } }),
      makeEvent({ decision: { result: "blocked", reason: "test", source: "ledger" } }),
      makeEvent({ decision: null }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, outcome: "approved-only" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
    assert.equal(getDecisionResult(result[0]!), "allowed");
  });

  it("filters to blocked-only", () => {
    const events = [
      makeEvent({ decision: { result: "allowed", reason: null, source: "ledger" } }),
      makeEvent({ decision: { result: "blocked", reason: "test", source: "ledger" } }),
      makeEvent({ decision: null }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, outcome: "blocked-only" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
    assert.equal(getDecisionResult(result[0]!), "blocked");
  });

  it("filters by event type", () => {
    const events = [
      makeEvent({ kind: "auth_checked" }),
      makeEvent({ kind: "heartbeat" }),
      makeEvent({ kind: "policy_set" }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, eventType: "heartbeat" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "heartbeat");
  });

  it("filters by contract address", () => {
    const events = [
      makeEvent({ contractId: "CABCDEF1234567890ABCDEF1234567890ABCDEF1234" }),
      makeEvent({ contractId: "CDEMO1234567890ABCDEF1234567890ABCDEF1234" }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, addressSearch: "ABCDEF1234" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 2);
  });

  it("filters by transaction hash", () => {
    const events = [
      makeEvent({ transactionHash: "abc123def456", contractId: "CDIFFERENT" }),
      makeEvent({ transactionHash: "xyz789", contractId: "CDEMO1234567890ABCDEF1234567890ABCDEF1234" }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, addressSearch: "abc123" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
  });

  it("filters by minimum stroop amount from data", () => {
    const events = [
      makeEvent({ data: { amount: 5000000n } }),
      makeEvent({ data: { amount: 50000000n } }),
      makeEvent({ data: {} }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, minStroops: 10000000n };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
    assert.equal(getDataAmount(result[0]!), 50000000n);
  });

  it("excludes events with null decision when outcome filter is active", () => {
    const events = [
      makeEvent({ decision: null }),
      makeEvent({ decision: { result: "allowed", reason: null, source: "ledger" } }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, outcome: "blocked-only" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 0);
  });

  it("returns empty array when no events match", () => {
    const events = [
      makeEvent({ kind: "auth_checked", decision: { result: "allowed", reason: null, source: "ledger" } }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, outcome: "blocked-only" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 0);
  });

  it("handles empty event list", () => {
    const result = filterEvents([], DEFAULT_FILTER);
    assert.equal(result.length, 0);
  });

  it("filters by event type and outcome combined", () => {
    const events = [
      makeEvent({ kind: "auth_checked", decision: { result: "blocked", reason: "test", source: "ledger" } }),
      makeEvent({ kind: "auth_checked", decision: { result: "allowed", reason: null, source: "ledger" } }),
      makeEvent({ kind: "heartbeat", decision: { result: "blocked", reason: "test", source: "ledger" } }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, eventType: "auth_checked", outcome: "blocked-only" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "auth_checked");
    assert.equal(getDecisionResult(result[0]!), "blocked");
  });

  it("filters by address and minimum stroops combined", () => {
    const events = [
      makeEvent({ contractId: "CABCDEF1234567890ABCDEF1234567890ABCDEF1234", data: { amount: 50000000n } }),
      makeEvent({ contractId: "CDEMO1234567890ABCDEF1234567890ABCDEF1234", data: { amount: 5000000n } }),
    ];
    const filter: TelemetryFilter = {
      ...DEFAULT_FILTER,
      addressSearch: "ABCDEF",
      minStroops: 10000000n,
    };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
  });

  it("treats null data amount as below minimum", () => {
    const events = [
      makeEvent({ data: {} }),
      makeEvent({ data: { amount: 10000000n } }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, minStroops: 10000000n };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
  });
});

describe("filterEvents with demo events", () => {
  it("filters demo events correctly", () => {
    const events = demoEvents(Date.now(), 6);
    const result = filterEvents(events, DEFAULT_FILTER);
    assert.equal(result.length, events.length);
  });

  it("applies outcome filter to demo events", () => {
    const events = demoEvents(Date.now(), 6);
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, outcome: "blocked-only" };
    const result = filterEvents(events, filter);
    assert.ok(result.length >= 0);
    for (const e of result) {
      assert.equal(getDecisionResult(e), "blocked");
    }
  });
});

describe("filterEvents edge cases", () => {
  it("handles event with no contractId when address search is empty", () => {
    const events = [makeEvent({ contractId: undefined as unknown as string })];
    const result = filterEvents(events, DEFAULT_FILTER);
    assert.equal(result.length, 1);
  });

  it("excludes event when contractId does not match address search", () => {
    const events = [makeEvent({ contractId: "CDIFFERENT" })];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, addressSearch: "CABCDEF" };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 0);
  });

  it("handles BigInt amounts in data", () => {
    const events = [
      makeEvent({ data: { amount: 10000000n } }),
      makeEvent({ data: { stroops: 5000000n } }),
    ];
    const filter: TelemetryFilter = { ...DEFAULT_FILTER, minStroops: 6000000n };
    const result = filterEvents(events, filter);
    assert.equal(result.length, 1);
  });
});
