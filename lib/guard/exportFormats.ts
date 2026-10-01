/**
 * Machine-readable exports of the telemetry feed, for compliance and forensics.
 *
 * The format is NDJSON (one JSON object per line). Line-oriented tools like
 * `jq`, log shippers and SIEM ingesters can stream it without loading the whole
 * file, and one bad line does not stop the rest from parsing. The file is a
 * structured audit log:
 *
 *   line 1      `record: "audit_header"`: who and what was exported, from which
 *               guard and network, with the filter that was applied.
 *   lines 2..n  `record: "guard_event"`: one per event, newest first as shown.
 *
 * Integers that can exceed 2^53 are written as decimal strings: ledger
 * sequences and every decoded `u64`/`i128` (stroop amounts, timestamps). JSON
 * numbers are IEEE doubles, so writing them as numbers would silently round
 * large values, and an audit log must not change the figures it records.
 *
 * Pure functions only: the component does the download, and tests can check
 * the exact bytes.
 */

import { toHex } from "stellar-agent-guard-sdk";
import type { TelemetryEvent } from "./telemetry.ts";
import { EMPTY_TELEMETRY_FILTER, type TelemetryFilter } from "./telemetryExport.ts";

export const AUDIT_LOG_SCHEMA = "stellar-agent-guard/telemetry-audit@1";

/**
 * Whether a filter narrows the feed. The filter itself — and the predicate that
 * applies it — is the feed's own (`telemetryExport.ts`), so the audit log always
 * describes exactly the view the operator had on screen.
 */
export function isFilterActive(filter: TelemetryFilter): boolean {
  return (
    filter.verdict !== EMPTY_TELEMETRY_FILTER.verdict ||
    filter.topic !== EMPTY_TELEMETRY_FILTER.topic ||
    filter.contract.trim() !== EMPTY_TELEMETRY_FILTER.contract
  );
}

/** Make any decoded value JSON-safe without losing precision or bytes. */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    // NaN/Infinity have no JSON form, and an unsafe integer has already lost
    // precision. Keep its decimal text rather than a misleading number.
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
      ? value
      : String(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return { hex: toHex(value) };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of value) out[String(toJsonSafe(key))] = toJsonSafe(entry);
    return out;
  }
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    // Objects that know how to render themselves (SDK `Address`, `Contract`, …)
    // are recorded as their canonical string, not as their internals.
    const ownToString = (value as { toString?: () => string }).toString;
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      ownToString !== Object.prototype.toString
    ) {
      return String(value);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toJsonSafe(entry);
    return out;
  }
  return String(value);
}

export interface AuditEventRecord {
  record: "guard_event";
  kind: string;
  topic: string;
  verdict: "allowed" | "blocked" | null;
  reason: string | null;
  source: string;
  contractId: string | null;
  /** Decimal string; see the module note on 64-bit integers. */
  ledger: string | null;
  /** When the ledger closed, or, for a diagnostic that never reached a ledger, when this console decoded it. */
  timestamp: string | null;
  timestampSource: "ledger_close" | "observed" | null;
  ledgerClosedAt: string | null;
  observedAt: string | null;
  transactionHash: string | null;
  /** The decoded event data, with 64-bit and 128-bit integers as strings. */
  data: unknown;
  raw: {
    eventId: string | null;
    topicXdr: string[];
    valueXdr: string | null;
    diagnosticEventXdr: string | null;
    inSuccessfulContractCall: boolean | null;
  } | null;
}

export function toAuditRecord(event: TelemetryEvent): AuditEventRecord {
  const observedAt = event.observedAt ?? null;
  const timestamp = event.ledgerClosedAt ?? observedAt;
  return {
    record: "guard_event",
    kind: event.kind,
    topic: event.topic,
    verdict: event.decision?.result ?? null,
    reason: event.decision?.reason ?? null,
    source: event.source,
    contractId: event.contractId,
    ledger: event.ledger === null || event.ledger === undefined ? null : String(event.ledger),
    timestamp,
    timestampSource: event.ledgerClosedAt ? "ledger_close" : observedAt ? "observed" : null,
    ledgerClosedAt: event.ledgerClosedAt,
    observedAt,
    transactionHash: event.transactionHash,
    data: toJsonSafe(event.data),
    raw: event.raw
      ? {
          eventId: event.raw.eventId,
          topicXdr: [...event.raw.topicXdr],
          valueXdr: event.raw.valueXdr,
          diagnosticEventXdr: event.raw.diagnosticEventXdr,
          inSuccessfulContractCall: event.raw.inSuccessfulContractCall,
        }
      : null,
  };
}

export interface AuditHeader {
  record: "audit_header";
  schema: string;
  exportedAt: string;
  guard: string;
  network: string;
  /** `filtered` when a filter narrowed the export; `full` for the whole buffer. */
  scope: "full" | "filtered";
  filter: TelemetryFilter;
  eventCount: number;
  /** How many events the in-memory buffer held, so a filtered export can be checked for completeness. */
  bufferedCount: number;
  latestLedger: string | null;
  demo: boolean;
}

export interface NdjsonExportParams {
  events: readonly TelemetryEvent[];
  bufferedCount: number;
  guard: string;
  network: string;
  filter: TelemetryFilter;
  latestLedger: number | null;
  demo: boolean;
  exportedAt?: Date;
}

// Built from code points so the source file itself stays free of the raw characters.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Serialise one record as a single NDJSON line.
 *
 * `JSON.stringify` already escapes `\n`, `\r`, quotes and control characters.
 * U+2028/U+2029 are legal raw inside JSON strings but are line terminators to
 * JavaScript and some line splitters, so they are escaped too. That keeps
 * "one line = one record" true for every consumer.
 */
export function ndjsonLine(record: unknown): string {
  return JSON.stringify(record)
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

/** Records to NDJSON: one object per line, each line `\n`-terminated. */
export function toNdjson(records: readonly unknown[]): string {
  return records.map((record) => `${ndjsonLine(record)}\n`).join("");
}

/** The full audit log: header line, then one line per event. */
export function telemetryToAuditLog(params: NdjsonExportParams): string {
  const header: AuditHeader = {
    record: "audit_header",
    schema: AUDIT_LOG_SCHEMA,
    exportedAt: (params.exportedAt ?? new Date()).toISOString(),
    guard: params.guard,
    network: params.network,
    scope: isFilterActive(params.filter) ? "filtered" : "full",
    filter: { ...params.filter, contract: params.filter.contract.trim() },
    eventCount: params.events.length,
    bufferedCount: params.bufferedCount,
    latestLedger: params.latestLedger === null ? null : String(params.latestLedger),
    demo: params.demo,
  };
  return toNdjson([header, ...params.events.map(toAuditRecord)]);
}

/** `guard-audit-log-2026-09-25T14-03-07Z.ndjson`: sortable, and safe on every filesystem. */
export function auditLogFilename(
  exportedAt: Date = new Date(),
  scope: "full" | "filtered" = "full",
): string {
  const stamp = exportedAt
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  return `guard-audit-log-${scope === "filtered" ? "filtered-" : ""}${stamp}.ndjson`;
}

export const NDJSON_MIME = "application/x-ndjson";
