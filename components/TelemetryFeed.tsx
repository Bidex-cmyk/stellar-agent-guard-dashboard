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

      <TelemetryFilterBar
        filter={filter}
        onChange={setFilter}
        totalEvents={events.length}
        filteredCount={filtered.length}
      />

      {filtered.length === 0 ? (
        <p className="tiny muted">
          {events.length === 0
            ? feed.watching
              ? "No events from this guard yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
              : "Start watching to tail this guard's events."
            : "No events match the current filters."}
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Feed holds the most recent {events.length} event(s) from{" "}
        <span className="mono">{short(guard, 8, 6)}</span>.
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
