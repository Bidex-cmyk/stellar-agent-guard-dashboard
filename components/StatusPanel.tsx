"use client";

import { deadManRemaining, describePolicy, isDeadManFrozen } from "stellar-agent-guard-sdk";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, Read, Stat, relativeTime, short } from "./bits.tsx";
import { PHASE1_ARTIFACT, NETWORK } from "../lib/guard/network.ts";
import { compilePrintReport } from "../lib/guard/printReport.ts";
import { calculateVelocity } from "../lib/guard/velocity.ts";


/**
 * The guard's live state, every field read from the chain on each refresh.
 *
 * The two freezes are shown separately rather than as one "frozen" light,
 * because they have different causes and the same single reversal is worth
 * knowing about: an admin freeze is something the operator just did, while a
 * dead-man-switch freeze is the account having gone quiet. `unfreeze()` clears
 * both, which is why it sits next to the panic button.
 */
export function StatusPanel() {
  const { snapshot, snapshotError, refreshing, refresh, guard, wallet } = useGuard();

  const printReport = snapshot ? compilePrintReport(snapshot, NETWORK.name, wallet?.address || "Disconnected") : null;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>On-chain state</h2>

        <div className="row">
          {snapshot && <span className="tiny muted">read {relativeTime(snapshot.fetchedAt)}</span>}
          <button className="secondary no-print" onClick={() => window.print()}>
            Print Compliance Report
          </button>
          <button className="secondary no-print" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Reading…" : "Refresh"}
          </button>
        </div>
      </div>

      <p className="tiny muted" style={{ marginTop: 10 }}>
        <span className="mono">{guard}</span>
      </p>

      {snapshotError && (
        <ErrorBlock
          title="The guard's state could not be read"
          detail={`${snapshotError} — no values are shown, because a failed read is not an empty policy.`}
        />
      )}

      {!snapshot && !snapshotError && <p className="muted tiny">Reading the chain…</p>}

      {snapshot && (
        <>
          <div className="grid" style={{ marginTop: 12 }}>
            <Stat
              label="Admin freeze"
              tone={snapshot.status.ok ? (snapshot.status.value.admin_frozen ? "danger" : "ok") : undefined}
              value={
                <Read
                  result={snapshot.status}
                  label="status()"
                  render={(status) => (status.admin_frozen ? "FROZEN" : "clear")}
                />
              }
              note="Set by the panic button; cleared by unfreeze()"
            />
            <Stat
              label="Dead-man switch"
              tone={
                snapshot.status.ok ? (snapshot.status.value.heartbeat_expired ? "danger" : "ok") : undefined
              }
              value={
                <Read
                  result={snapshot.status}
                  label="status()"
                  render={(status) =>
                    isDeadManFrozen(status) ? "FIRED" : status.heartbeat_expired ? "expired" : "within grace"
                  }
                />
              }
              note={
                <Read
                  result={snapshot.status}
                  label="status()"
                  render={(status) => {
                    const policy = snapshot.policy.ok ? snapshot.policy.value : null;
                    const remaining = deadManRemaining(status, policy);
                    if (remaining === null) return "switch disabled (grace 0)";
                    if (remaining < 0n) return "grace elapsed; account refuses calls";
                    return `${remaining}s of grace left`;
                  }}
                />
              }
            />
            <Stat
              label="Policy installed"
              value={<Read result={snapshot.status} label="status()" render={(s) => (s.has_policy ? "yes" : "no — default deny")} />}
              note="With no policy the account refuses every call"
            />
            <Stat
              label="Last heartbeat"
              value={
                <Read
                  result={snapshot.status}
                  label="status()"
                  render={(status) =>
                    status.last_heartbeat === 0n
                      ? "never"
                      : `${Number(status.last_heartbeat)} (ledger time)`
                  }
                />
              }
              note="Written by the agent's own heartbeat(), not by this console"
            />
          </div>

          <h3>Rolling window</h3>
          <Read
            result={snapshot.window}
            label="Window"
            render={(window) => {
              const policy = snapshot.policy.ok ? snapshot.policy.value : null;
              if (!window || !policy) {
                return (
                  <p className="tiny muted">No spend recorded yet in this policy&apos;s window.</p>
                );
              }
              const cap = policy.window_cap;
              const pct = cap > 0n ? Number((window.total * 100n) / cap) : null;
              
              const now = snapshot.status.ok ? snapshot.status.value.now : null;
              let velocityStats = null;
              if (now !== null) {
                const remaining = cap > 0n ? (cap > window.total ? cap - window.total : 0n) : null;
                const metrics = calculateVelocity(window.entries, now, remaining);
                const exhaust = metrics.exhaustionMinutes;
                
                // orange/red if exhaustion < 30 minutes
                const isCritical = exhaust !== null && exhaust < 30;
                const velocityTone = isCritical ? "danger" : "ok";
                
                velocityStats = (
                  <>
                    <h4 style={{ marginTop: 20 }}>Spending Velocity</h4>
                    <div className="grid">
                      <Stat label="1m Velocity" value={metrics.spend1m.toString()} />
                      <Stat 
                        label="15m Velocity" 
                        value={metrics.spend15m.toString()} 
                        tone={isCritical ? "danger" : undefined} 
                        note={exhaust !== null ? `Cap exhaustion in ~${Math.round(exhaust)}m` : undefined} 
                      />
                      <Stat label="1h Velocity" value={metrics.spend1h.toString()} />
                    </div>
                    {cap > 0n && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8em', marginBottom: 4 }}>
                          <span>Window Utilization</span>
                          <span style={{ color: isCritical ? 'var(--danger)' : undefined }}>{pct}%</span>
                        </div>
                        <div style={{ width: '100%', backgroundColor: '#222', height: 12, borderRadius: 6, overflow: 'hidden' }}>
                          <div style={{ 
                            width: `${Math.min(pct || 0, 100)}%`, 
                            backgroundColor: isCritical ? 'var(--danger)' : (pct && pct > 80 ? 'var(--warn)' : 'var(--ok)'), 
                            height: '100%',
                            transition: 'width 0.3s ease'
                          }} />
                        </div>
                      </div>
                    )}
                  </>
                );
              }

              return (
                <>
                  <div className="grid">
                    <Stat label="Spent in window" value={window.total.toString()} note={pct === null ? "no window cap set" : `${pct}% of the ${cap} cap`} />
                    <Stat label="Window length" value={`${policy.window_secs}s`} note={`${window.entries.length} entry(ies) on the ledger`} />
                  </div>
                  {velocityStats}
                </>
              );
            }}
          />

          <h3>Policy in force</h3>
          <Read
            result={snapshot.policy}
            label="policy()"
            render={(policy) =>
              policy === null ? (
                <p className="tiny muted">No policy installed — the account is in default-deny.</p>
              ) : (
                <>
                  <p className="tiny mono">{describePolicy(policy)}</p>
                  <div className="grid">
                    <Stat label="Per-transaction cap" value={policy.per_tx_cap === 0n ? "off" : policy.per_tx_cap.toString()} />
                    <Stat label="Rolling cap" value={policy.window_cap === 0n ? "off" : `${policy.window_cap} / ${policy.window_secs}s`} />
                    <Stat label="Assets" value={policy.assets.length} note="SAC tokens whose transfers are fully enforced" />
                    <Stat
                      label="Recipients"
                      value={policy.allow_any_recipient ? "any" : policy.recipients.length}
                      note={policy.allow_any_recipient ? "allowlist bypassed" : "allowlisted destinations"}
                    />
                    <Stat label="Protocols" value={policy.protocols.length} note="allowlisted non-asset contracts" />
                    <Stat
                      label="Account"
                      value={policy.paused ? "PAUSED" : "active"}
                      tone={policy.paused ? "warn" : undefined}
                      note={
                        policy.active_from === 0n && policy.active_until === 0n
                          ? "no active window"
                          : `active ${policy.active_from}–${policy.active_until}`
                      }
                    />
                  </div>
                </>
              )
            }
          />

          <h3>Artifact identity</h3>
          <Read
            result={snapshot.identity}
            label="wasm identity"
            render={(identity) => (
              <>
                <div className="grid">
                  <Stat
                    label="Ledger reports"
                    value={
                      <>
                        <span className="mono tiny no-print">{short(identity.reportedWasmHash ?? "-", 10, 6)}</span>
                        <span className="mono tiny print-only">{identity.reportedWasmHash ?? "-"}</span>
                      </>
                    }
                  />
                  <Stat
                    label="Fetched bytes hash to"
                    value={
                      <>
                        <span className="mono tiny no-print">{short(identity.fetchedSha256, 10, 6)}</span>
                        <span className="mono tiny print-only">{identity.fetchedSha256}</span>
                      </>
                    }
                  />
                  <Stat label="Bytecode size" value={identity.bytes} note="bytes" />
                  <Stat
                    label="Pinned Phase 1 artifact"
                    tone={identity.reportedWasmHash === PHASE1_ARTIFACT.wasmHash ? "ok" : "warn"}
                    value={
                      identity.reportedWasmHash === PHASE1_ARTIFACT.wasmHash
                        ? "match"
                        : "different artifact"
                    }
                    note={
                      identity.reportedWasmHash === PHASE1_ARTIFACT.wasmHash
                        ? "byte-for-byte the artifact Phase 1 proved"
                        : "this instance is not the artifact Phase 1 proved"
                    }
                  />
                </div>
              </>
            )}
          />
        </>
      )}

      {printReport && (
        <div className="print-only print-report">
          <h2>Compliance Audit Report</h2>
          <p><strong>Timestamp:</strong> {printReport.timestamp}</p>
          <p><strong>Network:</strong> {printReport.network}</p>
          <p><strong>Contract ID:</strong> <span className="mono">{printReport.contractId}</span></p>
          <p><strong>Bytecode Hash:</strong> <span className="mono">{printReport.bytecodeHash}</span></p>
          <p><strong>Admin Key:</strong> <span className="mono">{printReport.adminKey}</span></p>
          <p><strong>DMS Status:</strong> {printReport.dmsStatus}</p>
          <p><strong>Policy Rules:</strong> {printReport.policyRules}</p>
          <div>
            <strong>Allowlists:</strong>
            <ul>
              <li>Assets: {printReport.allowlists.assets.join(", ") || "None"}</li>
              <li>Recipients: {printReport.allowlists.recipients.join(", ") || "None"}</li>
              <li>Protocols: {printReport.allowlists.protocols.join(", ") || "None"}</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
