"use client";

import { memo, useState } from "react";
import { describeGuardEvent, explainReason, GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { eventKey, useGuard, useGuardEvents } from "./GuardProvider.tsx";
import { TelemetryAlerts } from "./TelemetryAlerts.tsx";
import { ErrorBlock, relativeTime, short, starLink } from "./bits.tsx";
import { DateRangePicker } from "./DateRangePicker.tsx";
import type { RangePreset, TimeRange } from "../lib/guard/ledgerTime.ts";
import {
  EMPTY_TELEMETRY_FILTER,
  filterGuardEvents,
  telemetryToCsv,
  telemetryToNdjson,
  type TelemetryFilter,
  type VerdictFilter,
} from "../lib/guard/telemetryExport.ts";

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
 * Two things are stated on the panel rather than glossed over, because both
 * change how the feed should be read:
 *
 *   - Soroban RPC has no push stream, so this polls `getEvents` with a cursor and
 *     the real latency floor is the ledger close interval, not the poll interval.
 *   - A *refused* decision never becomes a transaction: the guard returns `Err`,
 *     which rolls the event back. So the feed can only carry refused decisions
 *     that this console produced itself, decoded from the enforced simulation's
 *     diagnostics and labelled `diagnostic`. Absence of refusals here does not
 *     mean absence of refusals on chain.
 */
export function TelemetryFeed() {
  // The feed subscribes to the events context itself: batches re-render this
  // panel and nothing else (see `GuardEventsContext`).
  const events = useGuardEvents();
  const { feed, startWatching, stopWatching, clearEvents, guard, queryRange, rangeLabel } =
    useGuard();
  const [filter, setFilter] = useState<TelemetryFilter>(EMPTY_TELEMETRY_FILTER);

  // The three controls and the exports all act on the same projection, so a
  // CSV/NDJSON download is provably the filtered view on screen — one row in,
  // one line out, never a hidden superset.
  const rows = filterGuardEvents(events, filter);
  const filterActive =
    filter.verdict !== EMPTY_TELEMETRY_FILTER.verdict ||
    filter.topic !== EMPTY_TELEMETRY_FILTER.topic ||
    filter.contract.trim() !== EMPTY_TELEMETRY_FILTER.contract;

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
          {feed.latestLedger !== null && <span className="tiny muted">ledger {feed.latestLedger}</span>}
          {feed.watching ? (
            <button className="secondary" onClick={stopWatching}>
              Stop
            </button>
          ) : (
            <button onClick={startWatching}>Start watching</button>
          )}
          <button className="secondary" onClick={clearEvents} disabled={events.length === 0}>
            Clear
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

      <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <label className="tiny muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Verdict
          <select
            aria-label="Verdict filter"
            value={filter.verdict}
            onChange={(event) =>
              setFilter((current) => ({ ...current, verdict: event.target.value as VerdictFilter }))
            }
          >
            <option value="all">All verdicts</option>
            <option value="allowed">Allowed Only</option>
            <option value="blocked">Blocked Only</option>
          </select>
        </label>
        <label className="tiny muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Topic
          <select
            aria-label="Topic filter"
            value={filter.topic}
            onChange={(event) => setFilter((current) => ({ ...current, topic: event.target.value }))}
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
          onChange={(event) => setFilter((current) => ({ ...current, contract: event.target.value }))}
          style={{ maxWidth: 240 }}
        />
        <button
          className="secondary"
          onClick={() => downloadText("guard-telemetry.csv", telemetryToCsv(rows), "text/csv;charset=utf-8")}
          disabled={rows.length === 0}
        >
          Export CSV
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
        {filterActive && (
          <button className="secondary" onClick={() => setFilter(EMPTY_TELEMETRY_FILTER)}>
            Clear filters
          </button>
        )}
      </div>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Tailed from Soroban RPC&apos;s <code>getEvents</code> with a cursor, so no event is delivered
        twice and none is skipped between polls. Soroban has no push stream — the floor on latency is
        the ledger close interval (roughly 5s), not the 5s poll.
        {feed.lastPolledAt && ` Last poll ${relativeTime(feed.lastPolledAt)}.`}
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

      <TelemetryAlerts />

      {events.length === 0 ? (
        <p className="tiny muted">
          {feed.watching
            ? "No events from this guard yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
            : "Start watching to tail this guard's events."}
        </p>
      ) : rows.length === 0 ? (
        <p className="tiny muted">
          No events match the current filter. The feed still holds {events.length} event(s);
          widen the verdict, topic or contract filter to see them.
        </p>
      ) : (
        <div className="scrolly">
          <table className="events">
            <thead>
              <tr>
                <th>Event</th>
                <th>Decision</th>
                <th>Source</th>
                <th>Ledger</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => (
                <TelemetryRow key={eventKey(event)} event={event} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Feed holds the most recent {events.length} event(s) from{" "}
        <span className="mono">{short(guard, 8, 6)}</span>.
        {filterActive && <> Showing {rows.length} matching the current filter.</>}
      </p>
    </div>
  );
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
 * The key is `eventKey`, the provider's own identity for de-duplication, so
 * React reconciles against the same uniqueness the feed guarantees: a new
 * event prepending shifts nothing, and no row is ever unmounted and rebuilt
 * merely because rows above it changed.
 */
const TelemetryRow = memo(function TelemetryRow({ event }: { event: GuardEvent }) {
  return (
    <tr>
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
        <span className={`pill${event.source === "diagnostic" ? " warn" : ""}`}>{event.source}</span>
      </td>
      <td className="mono tiny">{event.ledger ?? "—"}</td>
      <td>
        {event.transactionHash ? (
          starLink(event.transactionHash)
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
