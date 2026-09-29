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

import { GuardTelemetryListener, guardEventsFromDiagnostics, topicSymbols } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";
import { estimateLedgerAtTime, type LedgerAnchor, type TimeRange } from "./ledgerTime.ts";

/**
 * The event exactly as the chain encoded it, kept next to the SDK's decoding.
 *
 * The SDK's `GuardEvent` is a decoded view and drops the XDR. An audit export
 * needs the original bytes, so a reviewer can re-decode them independently
 * instead of trusting this console's decoder. Every field is base64 XDR or an
 * RPC identifier, so it is stored as the RPC returned it.
 */
export interface RawEventXdr {
  /** stellar-rpc's event id (TOID-based, usable as a cursor); null for diagnostics. */
  eventId: string | null;
  /** Each topic as base64 `ScVal` XDR, in order. */
  topicXdr: string[];
  /** The event body as base64 `ScVal` XDR. */
  valueXdr: string | null;
  /** The whole `DiagnosticEvent` as base64 XDR, for refusals decoded from a simulation. */
  diagnosticEventXdr: string | null;
  inSuccessfulContractCall: boolean | null;
}

/** A decoded guard event plus the raw XDR it came from and when this console saw it. */
export type TelemetryEvent = GuardEvent & {
  raw?: RawEventXdr | null;
  /** ISO time this console decoded the event: the only timestamp a diagnostic has. */
  observedAt?: string;
};

export interface TelemetryPage {
  events: TelemetryEvent[];
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

  /** The raw `getEvents` page behind the most recent poll, captured for `raw`. */
  private lastRawEvents: readonly rpc.Api.EventResponse[] = [];

  constructor(server: rpc.Server, guard: string, rpcUrl: string = NETWORK.rpcUrl) {
    this.guard = guard;
    // The listener decodes and discards the XDR. Hand it a view of the server
    // whose `getEvents` also records the raw page, so the export can carry the
    // original bytes without re-implementing the SDK's decoding here.
    const recording = Object.create(server) as rpc.Server;
    recording.getEvents = async (request) => {
      const response = await server.getEvents(request);
      this.lastRawEvents = response.events;
      return response;
    };
    this.listener = new GuardTelemetryListener({ server: recording, guard, rpcUrl });
  }

  /** One page of committed ledger events. Advances the cursor. */
  async pollOnce(limit = 50): Promise<TelemetryPage> {
    const params: { cursor?: string; limit: number; startLedger?: number } = { limit };
    if (this.cursor) {
      params.cursor = this.cursor;
    } else if (this.latestLedger !== null) {
      params.startLedger = this.latestLedger;
    }
    this.lastRawEvents = [];
    const decoded = await this.listener.poll(params);
    const page = { ...decoded, events: attachLedgerXdr(decoded.events, this.lastRawEvents) };
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
    this.lastRawEvents = [];
    const decoded = await this.listener.poll({ startLedger, limit });
    const page = { ...decoded, events: attachLedgerXdr(decoded.events, this.lastRawEvents) };
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
): TelemetryEvent[] {
  // Some RPC paths hand back base64 strings rather than decoded events; the
  // SDK's decoder only reads decoded ones, so normalise first.
  const normalised = diagnosticEvents.map(decodeIfBase64);
  const decoded = guardEventsFromDiagnostics(normalised, guard);
  const observedAt = new Date().toISOString();
  // The SDK skips events whose topics it does not recognise but keeps the
  // order of the rest, so walk both lists together and pair them by name topic.
  let cursor = 0;
  return decoded.map((event) => {
    while (cursor < normalised.length) {
      const candidate = normalised[cursor++];
      if (topicSymbols(candidate)[0] === event.topic) {
        return { ...event, observedAt, raw: diagnosticXdr(candidate) };
      }
    }
    return { ...event, observedAt, raw: null };
  });
}

/**
 * Pair decoded ledger events with the raw page they came from.
 *
 * The listener drops unrecognised topics but keeps the order of the rest, so a
 * single forward walk matching ledger, transaction and name topic lines the two
 * lists up.
 */
export function attachLedgerXdr(
  decoded: readonly GuardEvent[],
  raw: readonly rpc.Api.EventResponse[],
): TelemetryEvent[] {
  const observedAt = new Date().toISOString();
  let cursor = 0;
  return decoded.map((event) => {
    while (cursor < raw.length) {
      const candidate = raw[cursor++]!;
      if (
        candidate.ledger === event.ledger &&
        (candidate.txHash ?? null) === event.transactionHash &&
        firstTopic(candidate) === event.topic
      ) {
        return {
          ...event,
          observedAt,
          raw: {
            eventId: candidate.id,
            topicXdr: candidate.topic.map((topic) => topic.toXDR("base64")),
            valueXdr: candidate.value.toXDR("base64"),
            diagnosticEventXdr: null,
            inSuccessfulContractCall: candidate.inSuccessfulContractCall ?? null,
          },
        };
      }
    }
    return { ...event, observedAt, raw: null };
  });
}

function firstTopic(event: rpc.Api.EventResponse): string | null {
  const [first] = event.topic;
  if (!first) return null;
  try {
    return String(scValToNative(first));
  } catch {
    return null;
  }
}

function decodeIfBase64(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return xdr.DiagnosticEvent.fromXDR(value, "base64");
  } catch {
    return value;
  }
}

interface XdrEncodable {
  toXDR(format: "base64"): string;
}

function isXdrEncodable(value: unknown): value is XdrEncodable {
  return typeof (value as XdrEncodable | null)?.toXDR === "function";
}

/** Raw XDR for one diagnostic event, whether it arrived decoded or as base64. */
function diagnosticXdr(value: unknown): RawEventXdr | null {
  try {
    const event =
      typeof value === "string" ? xdr.DiagnosticEvent.fromXDR(value, "base64") : value;
    if (!(event instanceof xdr.DiagnosticEvent)) {
      return isXdrEncodable(value)
        ? { eventId: null, topicXdr: [], valueXdr: null, diagnosticEventXdr: value.toXDR("base64"), inSuccessfulContractCall: null }
        : null;
    }
    const body = event.event.body.v0;
    return {
      eventId: null,
      topicXdr: body.topics.map((topic) => topic.toXDR("base64")),
      valueXdr: body.data.toXDR("base64"),
      diagnosticEventXdr: event.toXDR("base64"),
      inSuccessfulContractCall: event.inSuccessfulContractCall,
    };
  } catch {
    return null;
  }
}

/**
 * The feed's display buffer, with a pause control.
 *
 * During a burst, new rows arriving at the top push the row an operator is
 * reading off screen. Pausing freezes what is displayed, **not** the poller:
 * the cursor keeps advancing in the background and new events wait in
 * `pending`. Resuming applies them exactly as if the stream had never been
 * paused, so a pause cannot duplicate a row or skip past one.
 *
 * Pure and immutable, so it drops straight into a React state updater and can
 * be tested without a DOM. Events are held newest first, the order the table
 * renders them.
 */
export interface StreamBuffer {
  /** What the table shows, newest first. */
  rows: TelemetryEvent[];
  /** Events that arrived while paused, newest first. They are not shown until resume. */
  pending: TelemetryEvent[];
  paused: boolean;
  /** Identities already accepted, so a re-polled page or re-pushed diagnostic is not shown twice. */
  seen: ReadonlySet<string>;
  /** Events that fell out of the pending queue while paused because it exceeded the buffer limit. */
  dropped: number;
}

/** How many rows the feed keeps. The feed is a live view, not an archive. */
export const STREAM_BUFFER_LIMIT = 250;

export function emptyStreamBuffer(): StreamBuffer {
  return { rows: [], pending: [], paused: false, seen: new Set(), dropped: 0 };
}

/**
 * A stable identity for an event, so re-polling the same page cannot duplicate
 * rows. Decoded event data can hold bigints (a heartbeat's `at`), which plain
 * `JSON.stringify` rejects, so they are written as decimal strings.
 */
export function eventKey(event: GuardEvent): string {
  return [
    event.source,
    event.transactionHash ?? "-",
    event.ledger ?? "-",
    event.topic,
    event.decision?.result ?? "-",
    event.decision?.reason ?? "-",
    typeof event.data === "object" && event.data !== null
      ? JSON.stringify(event.data, (_key, value: unknown) => (typeof value === "bigint" ? `${value}n` : value))
      : String(event.data),
  ].join("|");
}

/**
 * Accept a batch of incoming events.
 *
 * Unseen events go on top of the visible rows, or into `pending` while paused.
 * `dedupe: false` is for sources that make every event unique by construction
 * but can repeat the same fields, such as the demo generator.
 */
export function ingestEvents(
  buffer: StreamBuffer,
  incoming: readonly TelemetryEvent[],
  options: { limit?: number; dedupe?: boolean } = {},
): StreamBuffer {
  const limit = options.limit ?? STREAM_BUFFER_LIMIT;
  const dedupe = options.dedupe ?? true;
  let seen = buffer.seen;
  const fresh: TelemetryEvent[] = [];
  for (const event of incoming) {
    if (dedupe) {
      const key = eventKey(event);
      if (seen.has(key)) continue;
      if (seen === buffer.seen) seen = new Set(buffer.seen);
      (seen as Set<string>).add(key);
    }
    fresh.push(event);
  }
  if (fresh.length === 0) return buffer;

  if (buffer.paused) {
    const queued = [...fresh, ...buffer.pending];
    return {
      ...buffer,
      seen,
      pending: queued.slice(0, limit),
      dropped: buffer.dropped + Math.max(0, queued.length - limit),
    };
  }
  return { ...buffer, seen, rows: [...fresh, ...buffer.rows].slice(0, limit) };
}

/**
 * A buffer holding a historical window's events as its rows, live and unpaused.
 * `seen` is rebuilt from exactly those rows, so returning to the live tail does
 * not re-suppress events the window displayed, nor re-show ones it did.
 */
export function historicalBuffer(events: readonly TelemetryEvent[]): StreamBuffer {
  return { ...emptyStreamBuffer(), rows: [...events], seen: new Set(events.map(eventKey)) };
}

export function pauseStream(buffer: StreamBuffer): StreamBuffer {
  return buffer.paused ? buffer : { ...buffer, paused: true };
}

/** Put the queued events on top of the rows, in arrival order, and go live again. */
export function resumeStream(buffer: StreamBuffer, limit: number = STREAM_BUFFER_LIMIT): StreamBuffer {
  if (!buffer.paused) return buffer;
  return {
    ...buffer,
    paused: false,
    rows: [...buffer.pending, ...buffer.rows].slice(0, limit),
    pending: [],
    dropped: 0,
  };
}

/**
 * Empty the visible list only.
 *
 * The poll cursor lives in `GuardFeed` and is not touched, so clearing never
 * re-scans the chain. `seen` is kept, so nothing already delivered can come
 * back. `pending` is kept too: those are events the operator has not seen yet,
 * and clearing what is on screen should not discard them silently.
 */
export function clearStreamRows(buffer: StreamBuffer): StreamBuffer {
  return { ...buffer, rows: [] };
}
