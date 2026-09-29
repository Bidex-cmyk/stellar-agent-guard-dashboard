/**
 * Shared telemetry fixtures: the event streams the E2E and perf specs feed
 * through the mocked Soroban RPC, plus a plain-object projection for unit tests
 * of the feed's filter/export logic.
 *
 * Fixtures are *descriptors* rather than XDR or `GuardEvent`s so the same
 * numbers can be asserted in Node unit tests, encoded into `getEvents` responses
 * by `tests/e2e/sorobanRpcMock.ts`, and reasoned about in specs — one source of
 * truth for "35 approved, 10 blocked, 5 heartbeats".
 *
 * Every descriptor carries a unique ascending ledger and transaction hash, so
 * the console's event-keyed de-duplication can never collapse two fixture rows.
 */

import { GUARD_EVENT_TOPICS, type GuardEvent } from "stellar-agent-guard-sdk";

export type MockEventKind =
  | "auth_checked"
  | "heartbeat"
  | "frozen"
  | "unfrozen"
  | "policy_set"
  | "initialized"
  | "policy_revoked";

export interface MockEventSpec {
  kind: MockEventKind;
  /** Only for `auth_checked`: what the guard decided, and why. */
  decision?: { result: "allowed" | "blocked"; reason?: string };
  ledger: number;
  ledgerClosedAt: string;
  /** 64-hex transaction hash, or `null` for events with no transaction. */
  transactionHash: string | null;
  /** Event body, as the console will see it after decoding. */
  data: Record<string, unknown>;
}

/** The mixed feed issue #113 specifies: 50 events with fixed proportions. */
export const MIXED_FEED_COUNTS = {
  approved: 35,
  blocked: 10,
  heartbeat: 5,
} as const;

export const MIXED_FEED_TOTAL =
  MIXED_FEED_COUNTS.approved + MIXED_FEED_COUNTS.blocked + MIXED_FEED_COUNTS.heartbeat;

/** The refusal reason every blocked transfer in the mixed feed carries. */
export const MIXED_FEED_BLOCK_REASON = "per_tx_cap_exceeded";

const TX_PREFIX = "bcd8eac52d6efb50eb2c8d7d9650493da9be7fe73b0be18a450282fa2400";

/** A deterministic 64-hex transaction hash for a fixture sequence. */
export function fixtureTxHash(sequence: number): string {
  const suffix = (sequence % 0xffff).toString(16).padStart(4, "0").slice(-4);
  return `${TX_PREFIX}${suffix}`;
}

interface SpecOptions {
  ledger: number;
  sequence: number;
  baseTimeMs: number;
}

function allowed(options: SpecOptions): MockEventSpec {
  return {
    kind: "auth_checked",
    decision: { result: "allowed" },
    ledger: options.ledger,
    ledgerClosedAt: new Date(options.baseTimeMs).toISOString(),
    transactionHash: fixtureTxHash(options.sequence),
    data: {},
  };
}

function blocked(options: SpecOptions): MockEventSpec {
  return {
    kind: "auth_checked",
    decision: { result: "blocked", reason: MIXED_FEED_BLOCK_REASON },
    ledger: options.ledger,
    ledgerClosedAt: new Date(options.baseTimeMs).toISOString(),
    // A refused decision never becomes a transaction — but the fixture feeds
    // it through `getEvents`, so it carries the ledger context of the call it
    // was decided in.
    transactionHash: fixtureTxHash(options.sequence),
    data: {},
  };
}

function heartbeat(options: SpecOptions): MockEventSpec {
  return {
    kind: "heartbeat",
    ledger: options.ledger,
    ledgerClosedAt: new Date(options.baseTimeMs).toISOString(),
    transactionHash: null,
    data: { at: Math.floor(options.baseTimeMs / 1000) },
  };
}

/**
 * The 50-event mixed stream: 35 approved transfers, 10 blocked cap-exceeded
 * decisions and 5 heartbeats, interleaved deterministically so filters have
 * something realistic to cut through.
 */
export function mixedTelemetryEvents(baseLedger = 5_000_000, baseTimeMs = Date.UTC(2026, 0, 1)): MockEventSpec[] {
  const events: MockEventSpec[] = [];
  let blockedUsed = 0;
  for (let index = 0; index < MIXED_FEED_TOTAL; index += 1) {
    const options: SpecOptions = {
      ledger: baseLedger + index,
      sequence: index,
      baseTimeMs: baseTimeMs + index * 5_000,
    };
    if (index % 10 === 9) {
      events.push(heartbeat(options));
    } else if (index % 3 === 1 && blockedUsed < MIXED_FEED_COUNTS.blocked) {
      blockedUsed += 1;
      events.push(blocked(options));
    } else {
      events.push(allowed(options));
    }
  }
  return events;
}

/**
 * A stream of `count` events cycling approved → blocked → heartbeat → approved,
 * for the throughput benchmark in issue #114.
 */
export function throughputTelemetryEvents(count: number, baseLedger = 6_000_000, baseTimeMs = Date.UTC(2026, 0, 1)): MockEventSpec[] {
  const events: MockEventSpec[] = [];
  const cycle = [allowed, blocked, heartbeat, allowed] as const;
  for (let index = 0; index < count; index += 1) {
    const factory = cycle[index % cycle.length]!;
    events.push(
      factory({
        ledger: baseLedger + index,
        sequence: index,
        baseTimeMs: baseTimeMs + index * 1_000,
      }),
    );
  }
  return events;
}

/**
 * Project a descriptor into the exact `GuardEvent` shape the console renders —
 * used by unit tests to exercise filter/export logic against the same events
 * the E2E specs serve over the mocked RPC.
 */
/** Kinds with a dedicated topic symbol, beyond the two decision kinds. */
const TOPIC_BY_KIND: Record<string, string> = {
  initialized: GUARD_EVENT_TOPICS.initialized,
  frozen: GUARD_EVENT_TOPICS.frozen,
  unfrozen: GUARD_EVENT_TOPICS.unfrozen,
  policy_set: GUARD_EVENT_TOPICS.policySet,
  policy_revoked: GUARD_EVENT_TOPICS.policyRevoked,
};

export function specToGuardEvent(spec: MockEventSpec, contractId: string): GuardEvent {
  const closedAt = spec.ledgerClosedAt;
  if (spec.kind === "heartbeat") {
    return {
      kind: "heartbeat",
      topic: GUARD_EVENT_TOPICS.heartbeat,
      source: "ledger",
      contractId,
      ledger: spec.ledger,
      ledgerClosedAt: closedAt,
      transactionHash: spec.transactionHash,
      decision: null,
      data: spec.data,
    };
  }
  if (spec.kind === "auth_checked") {
    return {
      kind: "auth_checked",
      topic: GUARD_EVENT_TOPICS.authChecked,
      source: "ledger",
      contractId,
      ledger: spec.ledger,
      ledgerClosedAt: closedAt,
      transactionHash: spec.transactionHash,
      decision: spec.decision
        ? {
            result: spec.decision.result,
            reason: spec.decision.reason ?? null,
            source: "ledger",
          }
        : null,
      data: spec.data,
    };
  }
  return {
    kind: spec.kind,
    topic: TOPIC_BY_KIND[spec.kind] ?? spec.kind,
    source: "ledger",
    contractId,
    ledger: spec.ledger,
    ledgerClosedAt: closedAt,
    transactionHash: spec.transactionHash,
    decision: null,
    data: spec.data,
  };
}

/** The whole mixed feed as `GuardEvent`s, ready for unit tests. */
export function mixedGuardEvents(contractId: string): GuardEvent[] {
  return mixedTelemetryEvents().map((spec) => specToGuardEvent(spec, contractId));
}
