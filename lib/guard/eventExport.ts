/**
 * Telemetry export (issue #37).
 *
 * The feed's events leave the console in one of two shapes — CSV or JSON —
 * and both share one contract, documented in `docs/export-schema.md`:
 *
 *   - The column list is **append-only**. New columns may be added at the
 *     end; existing columns are never renamed, reordered, or removed, so a
 *     script written against today's export keeps parsing tomorrow's.
 *   - Every cell is a **string**. Ledger sequences, ISO timestamps and
 *     transaction hashes pass through untouched — nothing is coerced to a
 *     number and no precision is lost.
 *   - Reason codes carry both the raw contract symbol (`reason`) and the
 *     SDK's human explanation (`reason_label`).
 *   - The CSV is BOM-prefixed so Excel opens it as UTF-8 instead of
 *     mojibake.
 *
 * `tests/unit/eventExport.test.ts` syncs this module against the doc, so the
 * two cannot drift apart silently.
 */
import { explainReason, type GuardEvent } from "stellar-agent-guard-sdk";

/** Bumped only when a change would break existing consumers — see the doc. */
export const EVENT_EXPORT_SCHEMA_VERSION = 1;

/**
 * The export's columns, in order. Append-only: add at the end, never remove
 * or reorder. The doc table and the tests both assert this list.
 */
export const EVENT_EXPORT_COLUMNS = [
  "schema_version",
  "guard",
  "topic",
  "kind",
  "source",
  "decision",
  "reason",
  "reason_label",
  "ledger",
  "ledger_closed_at",
  "transaction_hash",
] as const;

export type EventExportColumn = (typeof EVENT_EXPORT_COLUMNS)[number];

/** One export row: every value is a string, keyed by column name. */
export type EventExportRow = Record<EventExportColumn, string>;

/**
 * Flatten one guard event into an export row.
 *
 * `guard` is stamped on every row rather than inferred from the event, so an
 * export keeps naming its guard even for diagnostic events the RPC stream
 * could not attribute. `decision` is `allowed` / `blocked` / empty (non-auth
 * events carry no decision); `reason` is the raw contract symbol.
 */
export function eventToExportRow(event: GuardEvent, guard: string): EventExportRow {
  const decision = event.decision;
  return {
    schema_version: String(EVENT_EXPORT_SCHEMA_VERSION),
    guard,
    topic: event.topic,
    kind: event.kind,
    source: event.source,
    decision: decision ? decision.result : "",
    reason: decision?.reason ?? "",
    reason_label: decision?.reason ? explainReason(decision.reason) : "",
    ledger: event.ledger === null ? "" : String(event.ledger),
    ledger_closed_at: event.ledgerClosedAt ?? "",
    transaction_hash: event.transactionHash ?? "",
  };
}

/**
 * Quote one CSV cell per RFC 4180: wrap it when it contains a quote, comma,
 * carriage return or line feed, and double any embedded quotes.
 */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Render the feed's events as CSV, rows in the order given.
 *
 * The string is BOM-prefixed (U+FEFF) so spreadsheet applications read it as
 * UTF-8; the header row is the column list verbatim.
 */
export function eventsToCsv(events: readonly GuardEvent[], guard: string): string {
  const lines: string[] = [EVENT_EXPORT_COLUMNS.join(",")];
  for (const event of events) {
    const row = eventToExportRow(event, guard);
    lines.push(EVENT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  // U+FEFF — the UTF-8 BOM, so Excel opens the file as UTF-8.
  return `\uFEFF${lines.join("\n")}\n`;
}

/** The JSON export: same rows, plus the schema version and column list. */
export function eventsToJson(
  events: readonly GuardEvent[],
  guard: string,
): {
  schemaVersion: number;
  columns: readonly EventExportColumn[];
  guard: string;
  rows: EventExportRow[];
} {
  return {
    schemaVersion: EVENT_EXPORT_SCHEMA_VERSION,
    columns: [...EVENT_EXPORT_COLUMNS],
    guard,
    rows: events.map((event) => eventToExportRow(event, guard)),
  };
}

/**
 * Deterministic export filename: `guard-events-<guard[:8]>-<YYYY-MM-DD>-<count>.<ext>`.
 *
 * The date is UTC (ISO), taken from `now` so callers (and tests) can pin it;
 * the guard prefix keeps exports from different guards distinguishable at a
 * glance, and the row count disambiguates same-day re-exports.
 */
export function exportFilename(
  guard: string,
  ext: "csv" | "json",
  rowCount: number,
  now: number = Date.now(),
): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `guard-events-${guard.slice(0, 8)}-${day}-${rowCount}.${ext}`;
}
