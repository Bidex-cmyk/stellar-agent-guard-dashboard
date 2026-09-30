"use client";

import type { PolicyDiff, DiffEntry } from "../lib/guard/policyDiff.ts";

const STATUS: Record<DiffEntry["status"], { sign: string; color: string; label: string }> = {
  added: { sign: "+", color: "#1a7f37", label: "added" },
  removed: { sign: "-", color: "#cf222e", label: "removed" },
  modified: { sign: "~", color: "#9a6700", label: "modified" },
  unchanged: { sign: "=", color: "#57606a", label: "unchanged" },
};

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(renderValue).join(", ") : "none";
  }
  return String(value);
}

/**
 * The last look an operator gets before a wallet prompt.
 *
 * `set_policy` is irreversible in the sense that matters: once signed, the new
 * caps are what the guard enforces. This renders the structured diff from
 * `lib/guard/policyDiff.ts` side by side and refuses to call `onConfirm` until
 * the operator has actually seen it.
 */
export function PolicyDiffModal({
  diff,
  onConfirm,
  onCancel,
}: {
  diff: PolicyDiff;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const changes = diff.entries.filter((entry) => entry.status !== "unchanged");

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Policy changes"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>Policy changes</h2>
        <p className="tiny muted">
          Review what will change before the wallet is prompted to sign. Signing installs the new
          policy and resets the rolling window.
        </p>

        {diff.warnings.length > 0 && (
          <div
            className="warning-badge"
            role="alert"
            style={{ background: "#fff8c5", border: "1px solid #d4a72c", padding: "8px 10px", margin: "10px 0" }}
          >
            {diff.warnings.map((warning, index) => (
              <div key={index}>⚠ {warning}</div>
            ))}
          </div>
        )}

        {changes.length === 0 ? (
          <p className="tiny">This policy is identical to the one currently installed.</p>
        ) : (
          <table className="diff-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Field</th>
                <th style={{ textAlign: "left" }}>Current</th>
                <th style={{ textAlign: "left" }}>New</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((entry) => {
                const status = STATUS[entry.status];
                return (
                  <tr key={entry.field} data-status={entry.status}>
                    <td>
                      <span
                        aria-hidden="true"
                        style={{ color: status.color, fontWeight: 700, marginRight: 6 }}
                      >
                        {status.sign}
                      </span>
                      {entry.field}
                      <span className="tiny muted"> ({status.label})</span>
                    </td>
                    <td className="mono tiny">{renderValue(entry.oldValue)}</td>
                    <td className="mono tiny">{renderValue(entry.newValue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <button onClick={onConfirm}>Confirm and sign</button>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
