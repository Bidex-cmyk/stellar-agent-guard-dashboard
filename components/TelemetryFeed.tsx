"use client";

import { useState } from "react";
import { describeGuardEvent, explainReason } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { filterEvents, DEFAULT_FILTER, type TelemetryFilter } from "../lib/guard/telemetry";
import { decodeRejection, type DecodedRejection } from "../lib/guard/rejectionDecoder";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, relativeTime, short, starLink } from "./bits.tsx";
import { TelemetryFilterBar } from "./TelemetryFilterBar.tsx";
import { RejectionDetailModal } from "./RejectionDetailModal.tsx";
import { memo, useState } from "react";
import { describeGuardEvent, explainReason, GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { STREAM_BUFFER_LIMIT, type TelemetryEvent } from "../lib/guard/telemetry.ts";
import { useGuard, useGuardEvents } from "./GuardProvider.tsx";
import { TelemetryAlerts } from "./TelemetryAlerts.tsx";
import { TelemetryChart } from "./TelemetryChart.tsx";
import { ErrorBlock, TimeAgo, short, starLink, TxHashCell } from "./bits.tsx";
import { DateRangePicker } from "./DateRangePicker.tsx";
import type { RangePreset, TimeRange } from "../lib/guard/ledgerTime.ts";
import {
  NDJSON_MIME,
  auditLogFilename,
  isFilterActive,
  telemetryToAuditLog,
} from "../lib/guard/exportFormats.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { useAnnounce } from "../lib/guard/useAnnounce.ts";
import { eventsToCsv, eventsToJson, exportFilename } from "../lib/guard/eventExport.ts";
import { useDemoMode } from "../lib/guard/useDemoMode.ts";
import {
  EMPTY_TELEMETRY_FILTER,
  filterGuardEvents,
  telemetryToCsv,
  telemetryToNdjson,
  type TelemetryFilter,
  type VerdictFilter,
} from "../lib/guard/telemetryExport.ts";
import { severityFor } from "../lib/guard/feedSeverity.ts";
import { decodeUrlState, writeUrlState } from "../lib/guard/urlState.ts";

/** Human names for the topic filter's options, keyed by the topic symbol. */
const TOPIC_LABELS: Record<string, string> = {
  [GUARD_EVENT_TOPICS.authChecked]: "Authorization decisions",
  [GUARD_EVENT_TOPICS.heartbeat]: "Agent heartbeats",
  [GUARD_EVENT_TOPICS.initialized]: "Account initialized",
  [GUARD_EVENT_TOPICS.frozen]: "Admin freeze",
  [GUARD_EVENT_TOPICS.unfrozen]: "Admin unfreeze",
  [GUARD_EVENT_TOPICS.policySet]: "Policy installed",
  [GUARD_EVENT_TOPICS.policyRevoked]: "Policy revoked",
};

/**
 * Save a text payload as a download.
 *
 * A blob URL with the `download` attribute, not a `data:` URL: the content can
 * be arbitrarily large (10k-event exports) and browsers cap data-URL
 * navigation. Revoking immediately after the click is safe — the browser has
 * already captured the blob by then.
 */
function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The live event feed.
 *
 * Three things are stated on the panel rather than glossed over, because all three
 * change how the feed should be read:
 *
 *   - Soroban RPC has no push stream, so this polls `getEvents` with a cursor and
 *     the real latency floor is the ledger close interval, not the poll interval.
 *   - A *refused* decision never becomes a transaction: the guard returns `Err`,
 *     which rolls the event back. So the feed can only carry refused decisions
 *     that this console produced itself, decoded from the enforced simulation's
 *     diagnostics and labelled `diagnostic`. Absence of refusals here does not
 *     mean absence of refusals on chain.
 *   - Rows are tiered by severity so a block is findable by looking, not by
 *     reading: the tier is a class and a `data-severity`, and every tier's wording
 *     is already in the row, so nothing here depends on colour.
 *
 * There is deliberately no sound. An operator console runs unattended and muted;
 * a noise that can only be silenced in the tab that made it is not an alert.
 */
export function TelemetryFeed() {
  const { events, feed, startWatching, stopWatching, clearEvents, guard } = useGuard();
  const [filter, setFilter] = useState<TelemetryFilter>(DEFAULT_FILTER);
  const [selected, setSelected] = useState<{ event: GuardEvent; rejection: DecodedRejection } | null>(null);

  const filtered = filterEvents(events, filter);

  function handleBlockedClick(event: GuardEvent) {
    if (event.decision?.result === "blocked" && event.decision.reason) {
      const decoded = decodeRejection(event.decision.reason, {
        contract: event.contractId,
        function: functionFromData(event.data),
        args: event.data,
      });
      setSelected({ event, rejection: decoded });
    }
  // The feed subscribes to the events context itself: batches re-render this
  // panel and nothing else (see `GuardEventsContext`).
  const events = useGuardEvents();
  const {
    feed,
    stream,
    pauseStream,
    resumeStream,
    startWatching,
    stopWatching,
    clearEvents,
    guard,
    queryRange,
    rangeLabel,
  } = useGuard();
  // The verdict filter a shared link carried (issue #132), settled in the
  // lazy initializer — the same convention the console's guard deep-link uses
  // for `?guard=` — so the restore needs no effect and the first client render
  // is the one that has it. `decodeUrlState` validates, so a malformed
  // `?filter=` restores nothing rather than a value no option matches.
  const [filter, setFilter] = useState<TelemetryFilter>(() => {
    if (typeof window === "undefined") return EMPTY_TELEMETRY_FILTER;
    const shared = decodeUrlState(window.location.search).filter;
    return shared === undefined
      ? EMPTY_TELEMETRY_FILTER
      : { ...EMPTY_TELEMETRY_FILTER, verdict: shared };
  });
  const announce = useAnnounce();
  const demo = useDemoMode();

  /**
   * Download the feed through the shared export path (issue #37). The schema,
   * BOM and filename rules all live in `lib/guard/eventExport.ts` — this is a
   * thin binding, not a second exporter.
   */
  function downloadExport(format: "csv" | "json") {
    const content =
      format === "csv"
        ? eventsToCsv(rows, guard)
        : JSON.stringify(eventsToJson(rows, guard), null, 2);
    const type = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(guard, format, rows.length);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    announce(
      `Exported ${rows.length} event${rows.length === 1 ? "" : "s"} as ${format.toUpperCase()}`,
    );
  }

  // The three controls and the exports all act on the same projection, so a
  // CSV/NDJSON download is provably the filtered view on screen — one row in,
  // one line out, never a hidden superset.
  const rows = filterGuardEvents(events, filter);
  const filterActive = isFilterActive(filter);

  /**
   * Download the structured audit log: a header line naming the guard, network
   * and filter, then one record per event with its raw XDR and every 64-bit
   * value as a decimal string. Like the other exports it is the filtered view
   * on screen; the header's `bufferedCount` shows how much the filter left out.
   */
  function exportAuditLog() {
    const exportedAt = new Date();
    const body = telemetryToAuditLog({
      events: rows,
      bufferedCount: events.length,
      guard,
      network: NETWORK.name,
      filter,
      latestLedger: feed.latestLedger,
      demo,
      exportedAt,
    });
    downloadText(
      auditLogFilename(exportedAt, filterActive ? "filtered" : "full"),
      body,
      `${NDJSON_MIME};charset=utf-8`,
    );
    announce(`Exported ${rows.length} event${rows.length === 1 ? "" : "s"} to the audit log`);
  }

  function applyRange(range: TimeRange, preset: RangePreset) {
    // A historical query replaces the live tail view: the feed shows exactly
    // the window asked for, and watching stops so a poll cannot overwrite it.
    stopWatching();
    void queryRange(range, preset);
  }

  function backToLive() {
    clearEvents();
    startWatching();
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Telemetry</h2>
        <div className="row">
          {feed.watching && <span className="pill ok">polling</span>}
          {stream.paused && <span className="pill warn">paused</span>}
          {feed.latestLedger !== null && (
            <span className="tiny muted">ledger {feed.latestLedger}</span>
          )}
          {feed.watching ? (
            <button className="secondary" onClick={stopWatching}>
              Stop
            </button>
          ) : (
            <button onClick={startWatching}>Start watching</button>
          )}
          {stream.paused ? (
            <button onClick={resumeStream}>
              Resume{stream.pendingCount > 0 ? ` (${stream.pendingCount})` : ""}
            </button>
          ) : (
            <button
              className="secondary"
              onClick={pauseStream}
              disabled={!feed.watching}
              title="Freeze the table so rows stop moving. Polling continues; new events queue until you resume."
            >
              Pause stream
            </button>
          )}
          <button
            className="secondary"
            onClick={clearEvents}
            disabled={events.length === 0}
            title="Empty the list. The poll cursor is kept, so nothing is re-fetched and nothing is skipped."
          >
            Clear buffer
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <DateRangePicker onApply={applyRange} />
        {rangeLabel && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="pill warn">historical: {rangeLabel}</span>
            <button className="secondary" onClick={backToLive}>
              Back to live tail
            </button>
          </div>
        )}
      </div>

      {/* Announced politely so a screen reader hears the queue grow without being interrupted. */}
      <div role="status" aria-live="polite">
        {stream.paused && (
          <div className="notice" style={{ marginTop: 12 }}>
            <strong>
              Stream paused ({stream.pendingCount} new event{stream.pendingCount === 1 ? "" : "s"}{" "}
              pending)
            </strong>
            <span className="tiny">
              The table is frozen so you can read it. Polling carries on in the background and new
              events queue here; resume to add them in order, with no duplicates and none skipped.
              {stream.dropped > 0 &&
                ` ${stream.dropped} older queued event${stream.dropped === 1 ? "" : "s"} fell past the ${STREAM_BUFFER_LIMIT}-event buffer and will not be shown.`}
            </span>
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <label
          className="tiny muted"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Verdict
          <select
            aria-label="Verdict filter"
            value={filter.verdict}
            onChange={(event) => {
              const verdict = event.target.value as VerdictFilter;
              setFilter((current) => ({ ...current, verdict }));
              // A filtered feed is the view a teammate should land on, so the
              // URL carries both the filter and the tab it belongs to — the
              // `?tab=telemetry&filter=blocked` of issue #132. Written with
              // `replaceState` through the shared codec: the table re-renders
              // from state, the page never reloads, and clearing the filter
              // removes the parameter again.
              writeUrlState({ filter: verdict, tab: verdict === "all" ? "console" : "telemetry" });
            }}
          >
            <option value="all">All verdicts</option>
            <option value="allowed">Allowed Only</option>
            <option value="blocked">Blocked Only</option>
          </select>
        </label>
        <label
          className="tiny muted"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Topic
          <select
            aria-label="Topic filter"
            value={filter.topic}
            onChange={(event) =>
              setFilter((current) => ({ ...current, topic: event.target.value }))
            }
          >
            <option value="all">All topics</option>
            {Object.entries(TOPIC_LABELS).map(([topic, label]) => (
              <option key={topic} value={topic}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label="Contract address search"
          placeholder="Contract address contains…"
          value={filter.contract}
          onChange={(event) =>
            setFilter((current) => ({ ...current, contract: event.target.value }))
          }
          style={{ maxWidth: 240 }}
        />
        <button
          className="secondary"
          onClick={() => downloadExport("csv")}
          disabled={rows.length === 0}
          title="Stable append-only schema (docs/export-schema.md): schema_version, guard, topic, kind, source, decision, reason, reason_label, ledger, ledger_closed_at, transaction_hash — BOM-prefixed for Excel"
        >
          Export CSV
        </button>
        <button
          className="secondary"
          onClick={() => downloadExport("json")}
          disabled={rows.length === 0}
          title="Same schema as the CSV export, as one JSON object: schemaVersion, columns, guard, rows"
        >
          Export JSON
        </button>
        <button
          className="secondary"
          onClick={() =>
            downloadText("guard-telemetry.ndjson", telemetryToNdjson(rows), "application/x-ndjson")
          }
          disabled={rows.length === 0}
        >
          Export NDJSON
        </button>
        <button
          className="secondary"
          onClick={exportAuditLog}
          disabled={rows.length === 0}
          title="NDJSON audit log: a header line, then decoded fields, verdict, ledger, transaction hash and the raw event XDR per event"
        >
          Export audit log
        </button>
        {filterActive && (
          <button className="secondary" onClick={() => setFilter(EMPTY_TELEMETRY_FILTER)}>
            Clear filters
          </button>
        )}
      </div>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Tailed from Soroban RPC&apos;s <code>getEvents</code> with a cursor, so no event is
        delivered twice and none is skipped between polls. Soroban has no push stream — the floor on
        latency is the ledger close interval (roughly 5s), not the 5s poll.
        {feed.lastPolledAt && (
          <>
            {" "}
            Last poll <TimeAgo iso={feed.lastPolledAt} suffix=" ago" />.
          </>
        )}
      </p>

      <div className="notice info">
        <strong>Refused decisions cannot reach this feed from the ledger</strong>
        <span className="tiny">
          When the guard refuses a call it returns an error, which rolls the event back — so a
          refused decision has no transaction and no committed event. Rows marked{" "}
          <em>diagnostic</em> are the refusals this console produced itself, decoded from the failed
          enforced simulation before broadcast. An empty feed is not evidence that nothing was
          refused on chain.
        </span>
      </div>

      {feed.error && <ErrorBlock title="The event feed could not poll" detail={feed.error} />}

      <TelemetryFilterBar
        filter={filter}
        onChange={setFilter}
        totalEvents={events.length}
        filteredCount={filtered.length}
      />

      {filtered.length === 0 ? (
      <TelemetryAlerts />

      <TelemetryChart />

      {events.length === 0 ? (
        <p className="tiny muted">
          {events.length === 0
            ? feed.watching
              ? "No events from this guard yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
              : "Start watching to tail this guard's events."
            : "No events match the current filters."}
        </p>
      ) : rows.length === 0 ? (
        <p className="tiny muted">
          No events match the current filter. The feed still holds {events.length} event(s); widen
          the verdict, topic or contract filter to see them.
        </p>
      ) : (
        <div className="scrolly">
          <table className="events">
            <thead>
              <tr>
                <th>Event</th>
                <th>Decision</th>
                <th>Source</th>
                <th>Time</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event: GuardEvent, index: number) => (
                <tr
                  key={`${event.topic}-${event.transactionHash ?? "-"}-${event.ledger ?? "-"}-${index}`}
                  onClick={() => handleBlockedClick(event)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") handleBlockedClick(event);
                  }}
                  tabIndex={event.decision?.result === "blocked" ? 0 : undefined}
                  style={{ cursor: event.decision?.result === "blocked" ? "pointer" : undefined }}
                >
                  <td>
                    <div>{labelFor(event)}</div>
                    <div className="tiny muted mono">{describeGuardEvent(event)}</div>
                  </td>
                  <td>
                    {event.decision ? (
                      event.decision.result === "blocked" ? (
                        <span className="pill danger">{event.decision.reason ?? "blocked"}</span>
                      ) : (
                        <span className="pill ok">allowed</span>
                      )
                    ) : (
                      <span className="muted tiny">—</span>
                    )}
                    {event.decision?.result === "blocked" && event.decision.reason && (
                      <>
                        <div className="tiny muted">{explainReason(event.decision.reason)}</div>
                        <button
                          className="secondary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleBlockedClick(event);
                          }}
                        >
                          Inspect
                        </button>
                      </>
                    )}
                  </td>
                  <td>
                    <span className={`pill${event.source === "diagnostic" ? " warn" : ""}`}>
                      {event.source}
                    </span>
                  </td>
                  <td className="mono tiny">{event.ledger ?? "—"}</td>
                  <td>{event.transactionHash ? starLink(event.transactionHash) : <span className="tiny muted">none — never broadcast</span>}</td>
                </tr>
              {rows.map((event) => (
                <TelemetryRow key={event.id} event={event} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Feed holds the most recent {events.length} event(s) from{" "}
        <span className="mono">{short(guard, 8, 6)}</span>.
        {filterActive && <> Showing {rows.length} matching the current filter.</>} The audit log
        keeps 64-bit values (ledgers, stroop amounts, timestamps) as strings so no precision is
        lost.
      </p>

      {selected && (
        <RejectionDetailModal
          rejection={selected.rejection}
          event={selected.event}
          onClose={() => setSelected(null)}
          onAdjustPolicy={(rejection) => {
            // Pre-populate policy form via a custom event that the
            // PolicyForm can listen for. The TelemetryFeed sets the
            // draft override state that the parent can consume.
            window.dispatchEvent(new CustomEvent("rejection-policy-adjust", {
              detail: rejection,
            }));
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function functionFromData(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  for (const key of ["function", "fn", "fname"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
/**
 * One feed row, memoised.
 *
 * The feed re-renders on every poll batch (and, under the #114 benchmark's
 * injection seam, many times a second), while a row's content is a pure
 * function of its own event. Memoising keeps the cost of a batch proportional
 * to the rows the batch actually added instead of to the feed's whole 250-row
 * cap — the difference between holding frame rate and remounting the table on
 * every update.
 *
 * The key is the SDK's `event.id`, the same identity the feed de-duplicates
 * on, so React reconciles against the same uniqueness the feed guarantees: a new
 * event prepending shifts nothing, and no row is ever unmounted and rebuilt
 * merely because rows above it changed.
 *
 * Severity rides here, on the row's own attributes, so the tier costs no extra
 * element and the cells stay exactly as they were — O(1) from fields the decoder
 * already produced, with no topic or reason string parsed (see `severityFor`).
 */
const TelemetryRow = memo(function TelemetryRow({ event }: { event: TelemetryEvent }) {
  const severity = severityFor(event);
  const iso = event.ledgerClosedAt ?? event.observedAt ?? null;
  return (
    <tr className={`severity-${severity}`} data-severity={severity} data-stream={event.source}>
      <td>
        <div>{labelFor(event)}</div>
        <div className="tiny muted mono">{describeGuardEvent(event)}</div>
      </td>
      <td>
        {event.decision ? (
          event.decision.result === "blocked" ? (
            <span className="pill danger">{event.decision.reason ?? "blocked"}</span>
          ) : (
            <span className="pill ok">allowed</span>
          )
        ) : (
          <span className="muted tiny">—</span>
        )}
        {event.decision?.result === "blocked" && event.decision.reason && (
          <div className="tiny muted">{explainReason(event.decision.reason)}</div>
        )}
      </td>
      <td>
        <span className={`pill${event.source === "diagnostic" ? " warn" : ""}`}>
          {event.source}
        </span>
      </td>
      <td className="mono tiny">
        {iso ? <TimeAgo iso={iso} /> : "—"}
        {event.ledger ? (
          <div className="muted" style={{ marginTop: 2 }}>
            L{event.ledger}
          </div>
        ) : null}
      </td>
      <td>
        {event.transactionHash ? (
          <TxHashCell hash={event.transactionHash} />
        ) : (
          <span className="tiny muted">none — never broadcast</span>
        )}
      </td>
    </tr>
  );
});

function labelFor(event: GuardEvent): string {
  switch (event.kind) {
    case "auth_checked":
      return "Authorization decision";
    case "heartbeat":
      return "Agent heartbeat";
    case "initialized":
      return "Account initialized";
    case "frozen":
      return "Admin freeze";
    case "unfrozen":
      return "Admin unfreeze";
    case "policy_set":
      return "Policy installed";
    case "policy_revoked":
      return "Policy revoked";
    default:
      return event.topic;
  }
}
