"use client";

import { useRef, useState } from "react";
import type { PolicyDraft } from "../lib/guard/policyForm.ts";
import {
  EMPTY_DRAFT,
  buildPolicyConfig,
  describeDraft,
  draftFromConfig,
} from "../lib/guard/policyForm.ts";
import { installPolicy, revokePolicy } from "../lib/guard/guardOps.ts";
import type { InvokeResult } from "../lib/guard/submit.ts";
import { refusedEventsFromDiagnostics } from "../lib/guard/telemetry.ts";
import {
  exportAssetCapsCsv,
  exportAssetCapsJson,
  mergeAssetCapOverrides,
  parseAssetCapsCsv,
  parseAssetCapsJson,
  type AssetCapChange,
} from "../lib/guard/assetCapsCsv.ts";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, ScopeNotice, starLink } from "./bits.tsx";
import { writeControlState } from "../lib/guard/observerMode.ts";

/**
 * The no-code configurator.
 *
 * The form is validated locally before a wallet is ever prompted, and the policy
 * is encoded by the SDK's `policyToScVal` rather than by a hand-rolled encoder —
 * the host converts the map into a typed struct by walking entries in a required
 * order, so a second encoder would be a second place to get the field order wrong.
 */
export function PolicyForm() {
  const { signer, guard, server, refresh, snapshot, pushEvents, wallet, notifyTabs } = useGuard();
  // `null` means "not edited yet", which is what lets the form seed itself from
  // the installed policy without an effect: the seed is derived during render and
  // the operator's first keystroke takes over from it.
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    { kind: "invalid"; issues: string[] } | { kind: "invoked"; result: InvokeResult } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [assetCapChanges, setAssetCapChanges] = useState<Record<string, AssetCapChange>>({});
  const csvInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);

  // Editing starts from the policy that is actually installed, not from an empty
  // form that looks like a reset. With nothing installed yet, it starts empty.
  const installedDraft =
    snapshot?.policy.ok && snapshot.policy.value !== null
      ? draftFromConfig(snapshot.policy.value)
      : EMPTY_DRAFT;
  const effective = draft ?? installedDraft;

  const validation = buildPolicyConfig(effective);
  const issues = validation.ok ? [] : validation.issues;

  // Every write here is inert for the same reason, in the same words as every
  // other write control in the console (issue #101).
  const installControl = writeControlState(wallet, {
    busy,
    extraDisabled: issues.length > 0,
    label: "install the policy",
  });
  const exportControl = writeControlState(wallet, {
    busy,
    extraDisabled: issues.length > 0,
    label: "export the policy",
  });
  const revokeControl = writeControlState(wallet, { busy, label: "revoke the policy" });

  function set<K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) {
    setDraft((current) => ({ ...(current ?? installedDraft), [key]: value }));
  }

  function updateAssetCaps(next: PolicyDraft["assetCaps"]) {
    set("assetCaps", next);
  }

  async function importAssetCaps(file: File, format: "csv" | "json") {
    try {
      const imported = format === "csv" ? parseAssetCapsCsv(await file.text()) : parseAssetCapsJson(await file.text());
      const merged = mergeAssetCapOverrides(effective.assetCaps, imported);
      updateAssetCaps(merged.rows);
      setAssetCapChanges((current) => ({ ...current, ...merged.changes }));
      setError(null);
    } catch (caught) {
      setError(`Asset-cap import failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  function downloadAssetCaps(filename: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function submit(exportOnly = false) {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await installPolicy({ server, signer: signer(), guard, draft: effective, exportOnly });
      setOutcome(result);
      if (result.kind === "invoked" && result.result.kind === "refused") {
        pushEvents(refusedEventsFromDiagnostics(result.result.diagnosticEvents, guard));
      }
      // Announce only a write that reached the chain; a refused call changed
      // nothing, so there is nothing for the other tabs to re-read.
      if (result.kind === "invoked" && result.result.kind === "submitted") {
        notifyTabs("POLICY_UPDATED", { payload: { operation: "set_policy" } });
      }
      if (!exportOnly) {
        await refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(exportOnly = false) {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await revokePolicy({ server, signer: signer(), guard, exportOnly });
      setOutcome({ kind: "invoked", result });
      if (result.kind === "submitted") {
        notifyTabs("POLICY_UPDATED", { payload: { operation: "revoke_policy" } });
      }
      if (!exportOnly) {
        await refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Guardrail policy</h2>
      <ScopeNotice />
      <p className="tiny muted">
        Installing a policy resets the rolling window and restarts the dead-man-switch clock, so a
        freshly installed policy always starts with full grace.
      </p>

      <div className="split" style={{ marginTop: 14 }}>
        <div>
          <label className="field">
            <span className="lbl">Per-transaction cap (blank = off)</span>
            <input
              value={effective.perTxCap}
              inputMode="numeric"
              onChange={(event) => set("perTxCap", event.target.value)}
              placeholder="1000"
            />
            <span className="hint">Largest single SAC transfer the account will authorize.</span>
          </label>

          <label className="field">
            <span className="lbl">Rolling-window cap (blank = off)</span>
            <input
              value={effective.windowCap}
              inputMode="numeric"
              onChange={(event) => set("windowCap", event.target.value)}
              placeholder="150"
            />
            <span className="hint">
              Total spend allowed inside a genuinely rolling window — not a fixed bucket that resets.
            </span>
          </label>

          <label className="field">
            <span className="lbl">Rolling-window length (seconds)</span>
            <input
              value={effective.windowSecs}
              inputMode="numeric"
              onChange={(event) => set("windowSecs", event.target.value)}
              placeholder="86400"
            />
            <span className="hint">How far back the rolling sum looks.</span>
          </label>

          <label className="field">
            <span className="lbl">Dead-man grace (seconds, blank = off)</span>
            <input
              value={effective.dmsGraceSecs}
              inputMode="numeric"
              onChange={(event) => set("dmsGraceSecs", event.target.value)}
              placeholder="skip"
            />
            <span className="hint">
              Freeze the account automatically if the agent has not heartbeated within this many
              seconds.
            </span>
          </label>

          <span className="lbl">Active from / until (unix seconds, blank = unrestricted)</span>
          <div className="row" style={{ marginBottom: 12 }}>
            <input
              value={effective.activeFrom}
              inputMode="numeric"
              onChange={(event) => set("activeFrom", event.target.value)}
              placeholder="from"
              aria-label="Active from"
            />
            <input
              value={effective.activeUntil}
              inputMode="numeric"
              onChange={(event) => set("activeUntil", event.target.value)}
              placeholder="until"
              aria-label="Active until"
            />
          </div>
        </div>

        <div>
          <label className="field">
            <span className="lbl">Assets — SAC token contracts (one per line)</span>
            <textarea
              rows={3}
              value={effective.assets}
              onChange={(event) => set("assets", event.target.value)}
              placeholder="CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"
            />
            <span className="hint">
              Transfers of these tokens get full recipient and amount enforcement.
            </span>
          </label>

          <div className="field">
            <span className="lbl">Per-asset cap overrides</span>
            <span className="hint">
              Bulk-edit asset contract addresses and positive stroop caps. Imported rows are merged by contract address.
            </span>
            <div className="row" style={{ margin: "8px 0" }}>
              <button className="secondary" type="button" onClick={() => csvInput.current?.click()} disabled={busy}>
                Import CSV
              </button>
              <button className="secondary" type="button" onClick={() => jsonInput.current?.click()} disabled={busy}>
                Import JSON
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => downloadAssetCaps("asset-cap-overrides.csv", exportAssetCapsCsv(effective.assetCaps))}
                disabled={busy || effective.assetCaps.length === 0}
              >
                Export CSV
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => downloadAssetCaps("asset-cap-overrides.json", exportAssetCapsJson(effective.assetCaps))}
                disabled={busy || effective.assetCaps.length === 0}
              >
                Export JSON
              </button>
              <input
                ref={csvInput}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importAssetCaps(file, "csv");
                }}
              />
              <input
                ref={jsonInput}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importAssetCaps(file, "json");
                }}
              />
            </div>
            {effective.assetCaps.length > 0 && (
              <table className="asset-caps">
                <thead>
                  <tr>
                    <th>Asset contract</th>
                    <th>Max cap (stroops)</th>
                    <th>Symbol</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {effective.assetCaps.map((row, index) => (
                    <tr key={row.assetContractAddress}>
                      <td>
                        <input
                          aria-label={`Asset contract ${index + 1}`}
                          value={row.assetContractAddress}
                          onChange={(event) => {
                            const next = [...effective.assetCaps];
                            next[index] = { ...row, assetContractAddress: event.target.value };
                            updateAssetCaps(next);
                          }}
                        />
                        {assetCapChanges[row.assetContractAddress] && (
                          <span className="pill ok asset-cap-badge">{assetCapChanges[row.assetContractAddress]}</span>
                        )}
                      </td>
                      <td>
                        <input
                          aria-label={`Maximum cap ${index + 1}`}
                          inputMode="numeric"
                          value={row.maxCapStroops}
                          onChange={(event) => {
                            const next = [...effective.assetCaps];
                            next[index] = { ...row, maxCapStroops: event.target.value };
                            updateAssetCaps(next);
                          }}
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Symbol ${index + 1}`}
                          value={row.symbol}
                          onChange={(event) => {
                            const next = [...effective.assetCaps];
                            next[index] = { ...row, symbol: event.target.value };
                            updateAssetCaps(next);
                          }}
                        />
                      </td>
                      <td>
                        <button
                          className="secondary"
                          type="button"
                          aria-label={`Remove ${row.symbol || "asset override"}`}
                          onClick={() => updateAssetCaps(effective.assetCaps.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <label className="field">
            <span className="lbl">Recipients (one per line)</span>
            <textarea
              rows={3}
              value={effective.recipients}
              onChange={(event) => set("recipients", event.target.value)}
              placeholder="GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"
            />
          </label>

          <div className="checkline">
            <input
              id="allow-any"
              type="checkbox"
              checked={effective.allowAnyRecipient}
              onChange={(event) => set("allowAnyRecipient", event.target.checked)}
            />
            <label htmlFor="allow-any">
              Allow any recipient (the caps still apply)
              <span className="hint">
                With this off, a transfer to an address that is not listed is refused.
              </span>
            </label>
          </div>

          <label className="field">
            <span className="lbl">Protocols — allowlisted contracts (one per line)</span>
            <textarea
              rows={3}
              value={effective.protocols}
              onChange={(event) => set("protocols", event.target.value)}
              placeholder="C…  or  C…:swap,deposit   (no colon = any function)"
            />
            <span className="hint">
              Calls to contracts outside this list are refused. Window and pause state still apply to
              these calls; per-call amount and recipient limits do not.
            </span>
          </label>

          <div className="checkline">
            <input
              id="paused"
              type="checkbox"
              checked={effective.paused}
              onChange={(event) => set("paused", event.target.checked)}
            />
            <label htmlFor="paused">
              Start paused
              <span className="hint">Installs the policy but refuses every call until resumed.</span>
            </label>
          </div>
        </div>
      </div>

      <h3>Review</h3>
      <p className="tiny mono">{describeDraft(effective)}</p>

      {issues.length > 0 && (
        <div className="error">
          <span className="t">This policy is not valid yet</span>
          <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
            {issues.map((issue) => (
              <li key={`${issue.field}-${issue.message}`} className="tiny">
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button
          disabled={installControl.disabled}
          title={installControl.title}
          onClick={() => void submit()}
        >
          {busy ? "Working…" : "Sign and install policy"}
        </button>
        <button
          className="secondary"
          disabled={exportControl.disabled}
          title={exportControl.title}
          onClick={() => void submit(true)}
        >
          Export XDR
        </button>
        <button
          className="secondary"
          disabled={revokeControl.disabled}
          title={revokeControl.title}
          onClick={() => void revoke()}
        >
          Revoke policy (default deny)
        </button>
        <button className="secondary" onClick={() => { setDraft(EMPTY_DRAFT); setAssetCapChanges({}); }} disabled={busy}>
          Clear form
        </button>
        <button
          className="secondary"
          onClick={() => { setDraft(null); setAssetCapChanges({}); }}
          disabled={busy || draft === null}
          title="Discard edits and load the policy currently installed on chain"
        >
          Load installed
        </button>
      </div>

      {error && <ErrorBlock title="The policy write did not complete" detail={error} />}

      {outcome?.kind === "invoked" && <OutcomeBlock result={outcome.result} verb="set_policy" onClose={() => setOutcome(null)} />}
      {outcome?.kind === "invalid" && (
        <ErrorBlock
          title="The policy was rejected before signing"
          detail={outcome.issues.join("; ")}
        />
      )}
    </div>
  );
}

export function OutcomeBlock({ result, verb, onClose }: { result: InvokeResult; verb: string; onClose?: () => void }) {
  if (result.kind === "exported") {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 style={{ margin: 0 }}>Exported Transaction XDR</h2>
            {onClose && <button className="secondary" onClick={onClose}>Close</button>}
          </div>
          <p className="tiny" style={{ marginBottom: "16px" }}>
            This unsigned transaction envelope is ready for external multi-sig signing.
          </p>
          <textarea
            readOnly
            value={result.xdr}
            style={{ width: "100%", height: "120px", marginBottom: "16px", fontSize: "12px", fontFamily: "monospace" }}
          />
          <div className="row">
            <button onClick={() => navigator.clipboard.writeText(result.xdr)}>Copy to Clipboard</button>
            <button
              onClick={() => {
                const blob = new Blob([result.xdr], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `unsigned-${verb}-${Date.now()}.tx`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download .tx
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (result.kind === "submitted") {
    return (
      <div className="notice info">
        <strong>
          {verb} landed on chain — {starLink(result.hash)}
        </strong>
        <span className="tiny">
          Ledger {result.ledger ?? "—"}. The panel above re-reads the contract to show the policy that
          is actually installed; this receipt proves the write, not that it did what you expected.
        </span>
      </div>
    );
  }
  if (result.kind === "refused") {
    return (
      <div className="error">
        <span className="t">
          Refused during {result.stage} — nothing was broadcast, so this cost nothing
        </span>
        <span className="mono tiny">{result.detail}</span>
      </div>
    );
  }
  return (
    <div className="error">
      <span className="t">
        Broadcast but rejected on chain — {starLink(result.hash)}
      </span>
      <span className="mono tiny">{result.detail}</span>
    </div>
  );
}
