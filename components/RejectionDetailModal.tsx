"use client";

import { useEffect } from "react";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import type { DecodedRejection } from "../lib/guard/rejectionDecoder";

interface RejectionDetailModalProps {
  rejection: DecodedRejection;
  /** The denied event row this rejection was opened from, when known. */
  event?: GuardEvent | null;
  onClose: () => void;
  onAdjustPolicy?: (rejection: DecodedRejection) => void;
}

export function RejectionDetailModal({
  rejection,
  event = null,
  onClose,
  onAdjustPolicy,
}: RejectionDetailModalProps) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const thresholds = rejection.thresholds;
  const calls = rejection.authCalls;
  const diagnostics = rejection.diagnostics;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Rejection detail"
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Rejection Detail</h2>
          <button className="secondary" onClick={onClose} aria-label="Close rejection detail">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="notice danger">
            <strong>{rejection.variant}</strong>
            {event?.contractId && (
              <span className="tiny mono" style={{ marginLeft: 8 }}>
                {event.contractId}
              </span>
            )}
          </div>

          <p className="modal-explanation">{rejection.explanation}</p>

          {event && (
            <p className="tiny muted">
              {event.source === "diagnostic"
                ? "Decoded from the enforced simulation's diagnostics — this refusal was never broadcast, so it has no transaction."
                : `Ledger ${event.ledger ?? "—"}`}
              {event.transactionHash ? ` · tx ${event.transactionHash.slice(0, 12)}…` : " · no transaction — never broadcast"}
            </p>
          )}

          {rejection.rawReason && (
            <p className="tiny muted">
              Raw reason code: <span className="mono">{rejection.rawReason}</span>
            </p>
          )}

          {thresholds && (thresholds.requested !== undefined || thresholds.cap !== undefined) && (
            <div className="thresholds">
              <h3>Violated clause</h3>
              <table className="events">
                <thead>
                  <tr>
                    <th>Requested</th>
                    <th>Cap</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="mono">{thresholds.requested?.toString() ?? "—"}</td>
                    <td className="mono">{thresholds.cap?.toString() ?? "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="call-tree">
            <h3>Authorization call tree</h3>
            {calls.length > 0 ? (
              <table className="events">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Function</th>
                    <th>Parameters</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call, index) => (
                    <tr key={`${call.contract ?? "unknown"}-${call.function ?? "unknown"}-${index}`}>
                      <td className="mono tiny">{call.contract ?? "—"}</td>
                      <td className="mono tiny">{call.function ?? "—"}</td>
                      <td className="mono tiny">{call.args ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="tiny muted">
                {event?.contractId
                  ? `Intercepted call on ${event.contractId} — no further parameter values were recorded for this refusal.`
                  : "No authorization call parameters were recorded for this refusal."}
              </p>
            )}
          </div>

          {diagnostics.length > 0 && (
            <div className="diagnostics">
              <h3>Simulation diagnostics</h3>
              <ul className="tiny mono" style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {diagnostics.map((line, index) => (
                  <li key={`${index}-${line.slice(0, 24)}`}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {rejection.policyException && (
            <div className="policy-exception">
              <h3>Policy Exception</h3>
              <p className="tiny muted">
                To allow this transaction, update the following field in the policy:
              </p>
              <table className="events">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Target</th>
                    <th>Suggested Value</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="mono">{rejection.policyException.field}</td>
                    <td>{rejection.policyException.target}</td>
                    <td className="mono">{rejection.policyException.value || "(enter new value)"}</td>
                  </tr>
                </tbody>
              </table>

              {onAdjustPolicy && (
                <button className="primary" onClick={() => onAdjustPolicy(rejection)}>
                  Adjust Policy to Allow
                </button>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
