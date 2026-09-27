/**
 * Telemetry: the guard's own events, from the two places they can exist.
 *
 * The part that is easy to get wrong, and which this module is shaped around: a
 * refused decision never reaches the ledger. The guard returns `Err`, which rolls
 * the event back, so a listener that only tails committed ledger events sees a
 * contract that appears to approve everything. The two sources are:
 *
 *   1. **ledger events** — allowed decisions, heartbeats, and the admin lifecycle
 *      events, tailed from `getEvents` with a cursor
 *      (`GuardTelemetryListener`, from the SDK).
 *   2. **simulation diagnostics** — refused decisions, which by construction have
 *      no transaction. The only place these arise in this dashboard is a write the
 *      operator attempted and the enforced simulation refused; the SDK's
 *      `guardEventsFromDiagnostics` decodes exactly those, and they are labelled
 *      `diagnostic` in the feed so they are never mistaken for settled history.
 *
 * "Real time" here means cursor-based polling of `getEvents`, because Soroban RPC
 * offers no push stream. The floor on latency is the ledger close interval, so
 * the feed reports the latest ledger it has seen rather than implying it is
 * instantaneous.
 */

import { GuardTelemetryListener, guardEventsFromDiagnostics } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";

/** Outcome filter options for the telemetry feed. */
export type OutcomeFilter = "all" | "approved-only" | "blocked-only";

/** Event type filter options for the telemetry feed. */
export type EventTypeFilter = "all" | "auth_checked" | "heartbeat" | "policy_set" | "frozen";

/** A single set of telemetry filter criteria. */
export interface TelemetryFilter {
  outcome: OutcomeFilter;
  eventType: EventTypeFilter;
  addressSearch: string;
  minStroops: bigint | null;
}

/** The default filter: show everything, no address search, no minimum amount. */
export const DEFAULT_FILTER: TelemetryFilter = {
  outcome: "all",
  eventType: "all",
  addressSearch: "",
  minStroops: null,
};

/**
 * Filter a list of GuardEvents against the given criteria.
 *
 * Applies all predicates conjunctively: an event must satisfy every
 * non-default criterion to appear in the result. Undetermined fields
 * (null decision, missing data) are handled gracefully:
 * - An outcome filter excludes events whose decision is null when
 *   the filter is not "all".
 * - A minimum stroop amount excludes events whose data does not
 *   contain a valid numeric amount at or above the threshold.
 */
export function filterEvents(events: GuardEvent[], filter: TelemetryFilter): GuardEvent[] {
  return events.filter((event) => {
    // Outcome filter
    if (filter.outcome !== "all") {
      if (event.decision === null) return false;
      const isAllowed = event.decision.result === "allowed";
      const isBlocked = event.decision.result === "blocked";
      if (filter.outcome === "approved-only" && !isAllowed) return false;
      if (filter.outcome === "blocked-only" && !isBlocked) return false;
    }

    // Event type filter
    if (filter.eventType !== "all" && event.kind !== filter.eventType) return false;

    // Address/contract search
    if (filter.addressSearch.trim() !== "") {
      const search = filter.addressSearch.trim().toLowerCase();
      const contractId = (event.contractId ?? "").toLowerCase();
      const txHash = (event.transactionHash ?? "").toLowerCase();
      if (!contractId.includes(search) && !txHash.includes(search)) return false;
    }

    // Minimum stroop amount
    if (filter.minStroops !== null) {
      const amount = extractStroops(event.data as Record<string, unknown> | undefined);
      if (amount === null || amount < filter.minStroops) return false;
    }

    return true;
  });
}

/**
 * Extract a stroop amount from an event's data field.
 *
 * Looks for a numeric amount value in the event data. Returns null
 * if the data does not contain a parseable integer amount.
 */
function extractStroops(data: Record<string, unknown> | undefined | null): bigint | null {
  if (typeof data === "undefined" || data === null) return null;

  // Common field names for stroop amounts in event data
  const candidates = ["amount", "stroops", "max_cap_stroops", "value"];
  for (const key of candidates) {
    const val = data[key];
    if (typeof val === "bigint") return val;
    if (typeof val === "number" && Number.isInteger(val)) return BigInt(val);
    if (typeof val === "string") {
      try {
        return BigInt(val);
      } catch {
        // not a valid integer string
      }
    }
  }
  return null;
}

export interface TelemetryPage {
  events: GuardEvent[];
  cursor: string;
  latestLedger: number;
}

/**
 * A cursor-carrying reader over one guard's event stream.
 *
 * The cursor is held here rather than re-derived from a ledger number on every
 * poll, because `getEvents` pagination is only stable while a cursor is carried
 * forward — re-scanning from a ledger can miss events that fell outside the
 * window between polls.
 */
/**
 * Note the explicit field declarations rather than constructor parameter
 * properties: this module is loaded by `node --test` and by the proof script
 * through Node's type-stripping loader, which rejects parameter properties
 * outright. Keeping the whole library strippable means the browser, the test
 * runner and the proof script execute the same source rather than three builds
 * of it.
 */
export class GuardFeed {
  readonly guard: string;
  private readonly listener: GuardTelemetryListener;
  private cursor: string | null = null;
  private latestLedger: number | null = null;

  constructor(server: rpc.Server, guard: string, rpcUrl: string = NETWORK.rpcUrl) {
    this.guard = guard;
    this.listener = new GuardTelemetryListener({ server, guard, rpcUrl });
  }

  /** One page of committed ledger events. Advances the cursor. */
  async pollOnce(limit = 50): Promise<TelemetryPage> {
    const params: { cursor?: string; limit: number; startLedger?: number } = { limit };
    if (this.cursor) {
      params.cursor = this.cursor;
    } else if (this.latestLedger !== null) {
      params.startLedger = this.latestLedger;
    }
    const page = await this.listener.poll(params);
    // A page with no events still advances the ledger pointer, so the next poll
    // does not re-scan a stretch of empty ledgers.
    this.latestLedger = Math.max(this.latestLedger ?? 0, page.latestLedger);
    if (page.cursor) this.cursor = page.cursor;
    return page;
  }

  /** Where the feed currently is, for display. */
  position(): { cursor: string | null; latestLedger: number | null } {
    return { cursor: this.cursor, latestLedger: this.latestLedger };
  }

  /** Forget the cursor so the feed re-scans from a given ledger. */
  resetFrom(ledger: number | null): void {
    this.cursor = null;
    this.latestLedger = ledger;
  }
}

/**
 * Decode refused-decision events out of an attempted write's diagnostics.
 *
 * These are the only refused decisions this interface can ever see, and they are
 * returned with `source: "diagnostic"` so the feed can say plainly that they were
 * never committed — a distinction that matters, because a rolled-back event is
 * evidence of a refusal, not of settled state.
 */
export function refusedEventsFromDiagnostics(
  diagnosticEvents: readonly unknown[],
  guard: string,
): GuardEvent[] {
  return guardEventsFromDiagnostics(diagnosticEvents, guard);
}
