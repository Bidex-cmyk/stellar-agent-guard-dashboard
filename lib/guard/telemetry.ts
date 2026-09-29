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
import { estimateLedgerAtTime, type LedgerAnchor, type TimeRange } from "./ledgerTime.ts";

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

  /**
   * One page of committed events from a historical time range (#148).
   *
   * The range's timestamps are converted to a ledger window with
   * `ledgerTime.ts` — anchored to the server's latest ledger, or to the last
   * observed ledger this feed has seen — and the resulting events are
   * filtered by their close timestamps so the inaccuracy of the ~5s ledger
   * estimate does not hand the operator rows from outside the range they
   * asked for. The estimate deliberately starts the window one ledger early
   * (`estimateLedgerAtTime`), and this filter is what makes that safe rather
   * than sloppy: extra rows are dropped, missed rows would be gone.
   *
   * The feed's live cursor is untouched — a historical query must not move
   * where "live" resumes.
   */
  async pollRange(range: TimeRange, limit = 200): Promise<TelemetryPage> {
    const anchor = await this.currentAnchor();
    const startLedger = Math.max(
      1,
      estimateLedgerAtTime(anchor, range.fromUnixSecs ?? anchor.closeTimeSecs),
    );
    const endLedger =
      range.toUnixSecs === null
        ? null
        : Math.max(startLedger, estimateLedgerAtTime(anchor, range.toUnixSecs));

    // The SDK listener owns the topic/value decoding and the filter shape, so
    // the page is fetched through it. `poll` with a `startLedger` (no cursor)
    // issues exactly one `getEvents` over the window's head; the range's end
    // bound is then applied locally by timestamp.
    const page = await this.listener.poll({ startLedger, limit });
    const filtered = page.events.filter((event) => {
      if (range.fromUnixSecs !== null && event.ledgerClosedAt) {
        if (Number(new Date(event.ledgerClosedAt)) / 1000 < range.fromUnixSecs) return false;
      }
      if (range.toUnixSecs !== null && event.ledgerClosedAt) {
        if (Number(new Date(event.ledgerClosedAt)) / 1000 > range.toUnixSecs) return false;
      }
      return true;
    });
    return { ...page, events: filtered };
  }

  /**
   * The anchor the range arithmetic uses: the server's latest ledger when it
   * can be read, falling back to the freshest close time this feed itself
   * observed. A feed that never polled has no fallback and reports the error.
   */
  private async currentAnchor(): Promise<LedgerAnchor> {
    try {
      const latest = await (
        this.listener as unknown as {
          config: { server: rpc.Server };
        }
      ).config.server.getLatestLedger();
      return { ledger: latest.sequence, closeTimeSecs: Number(latest.closeTime) };
    } catch (error) {
      if (this.latestLedger !== null) {
        // Without a close time the best available anchor is "now": the latest
        // ledger this feed saw is, by definition of "latest", recent.
        return { ledger: this.latestLedger, closeTimeSecs: Math.floor(Date.now() / 1000) };
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
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
