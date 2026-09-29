"use client";

import { useEffect, useRef, useState } from "react";
import type { InvokeResult } from "../lib/guard/submit.ts";
import { freezeGuard, unfreezeGuard } from "../lib/guard/guardOps.ts";
import { refusedEventsFromDiagnostics } from "../lib/guard/telemetry.ts";
import { useGuard } from "./GuardProvider.tsx";
import { WRITE_DISABLED_HINT, writeControlState } from "../lib/guard/observerMode.ts";
import { ErrorBlock, starLink } from "./bits.tsx";

/**
 * The emergency panic button.
 *
 * The whole point of this panel is that "the UI said it worked" is not the
 * evidence. After a freeze it re-reads `status()` from the chain and shows what
 * the contract itself reports, and it refuses to claim success if the flag did
 * not actually change — a write that was signed and included but did not take
 * effect must not be reported as a freeze.
 */

type Phase = "idle" | "confirming" | "signing" | "verifying" | "done";

interface Report {
  action: "freeze" | "unfreeze";
  result: InvokeResult;
  /** `status()` re-read from the chain after the write. */
  adminFrozenAfter: boolean | null;
  /** True only when the re-read confirms the intended effect. */
  confirmed: boolean;
  note: string;
}

export function PanicPanel() {
  const { signer, guard, server, refresh, snapshot, pushEvents, wallet, notifyTabs } = useGuard();
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirming = phase === "confirming";

  // Focus management for the confirmation dialog: move focus in on open, keep
  // Tab cycling inside it, close on Escape, and restore focus to the trigger
  // whenever the dialog goes away. Without this a modal is either a keyboard
  // trap (focus escapes into the page behind it) or a dead end (focus lands
  // nowhere on dismissal) — both fail WCAG 2.1 AA keyboard requirements.
  useEffect(() => {
    if (!confirming) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );

    // Focus the dialog itself first, so a screen reader announces the title
    // before the operator tabs into its controls.
    dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPhase("idle");
        setAcknowledged(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && dialog.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Dismissal in any form (Escape, Cancel, or proceeding to sign) returns
      // focus to the trigger. The trigger row is re-created when the dialog
      // closes, and React re-attaches refs during the commit — before this
      // cleanup runs — so the ref already points at the live button. Reading
      // `.current` at cleanup time is the whole point; a snapshot taken when
      // the effect started would be null (the row is unmounted while the
      // dialog is open) or a detached node.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate late ref read, see above
      triggerRef.current?.focus();
    };
  }, [confirming]);

  const alreadyFrozen = snapshot?.status.ok ? snapshot.status.value.admin_frozen : null;
  // The panic button is the write an operator reaches for under pressure, so an
  // inert one has to say why in the same words as every other control (#101).
  const freezeControl = writeControlState(wallet, {
    extraDisabled: alreadyFrozen === true,
    label: "freeze this account",
  });
  const unfreezeControl = writeControlState(wallet, {
    extraDisabled: alreadyFrozen === false,
    label: "unfreeze this account",
  });

  async function run(action: "freeze" | "unfreeze", exportOnly = false) {
    setError(null);
    setReport(null);
    setPhase("signing");
    try {
      const walletSigner = signer();
      const result =
        action === "freeze"
          ? await freezeGuard({ server, signer: walletSigner, guard, exportOnly })
          : await unfreezeGuard({ server, signer: walletSigner, guard, exportOnly });

      // Surface any refused-decision diagnostics the write produced, so a refusal
      // appears in the feed rather than only in this panel.
      if (result.kind === "refused") {
        pushEvents(refusedEventsFromDiagnostics(result.diagnosticEvents, guard));
      }

      if (result.kind === "exported") {
        setReport({
          action,
          result,
          adminFrozenAfter: null,
          confirmed: false,
          note: "Transaction XDR exported for offline signing"
        });
        setPhase("done");
        return;
      }

      // Re-read the contract's own view. This is the step that makes the claim
      // real: the UI is not the source of truth, `status()` is.
      setPhase("verifying");
      const { readStatus } = await import("../lib/guard/chain.ts");
      const after = await readStatus(server, guard, wallet?.address);
      const adminFrozenAfter = after.ok ? after.value.admin_frozen : null;
      const expected = action === "freeze";
      const confirmed = adminFrozenAfter !== null && adminFrozenAfter === expected;

      setReport({
        action,
        result,
        adminFrozenAfter,
        confirmed,
        note: !after.ok
          ? `the write returned, but status() could not be re-read to confirm its effect: ${after.error}`
          : confirmed
            ? `status().admin_frozen now reads ${adminFrozenAfter}, which is the ${action} taking effect`
            : `status().admin_frozen reads ${adminFrozenAfter} — the intended effect is NOT visible on chain`,
      });
      setPhase("done");
      // Only a broadcast write can have moved the chain. Tell the other tabs so
      // they re-read instead of showing the pre-freeze world for up to a poll
      // interval — the one delay that matters when the agent is misbehaving.
      if (result.kind === "submitted") notifyTabs("FREEZE_STATE_CHANGED", { payload: { action } });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase("idle");
      setAcknowledged(false);
    }
  }

  return (
    <div className="panel">
      <h2>Emergency</h2>

      <p className="tiny muted">
        Freezing sets the account&apos;s admin freeze, after which <code>__check_auth</code> refuses
        every call the account would make — the agent stops being able to move anything. The freeze is
        reversible: <code>unfreeze()</code> clears it and restarts the heartbeat clock, so it is also
        the way back from a dead-man-switch freeze.
      </p>

      {alreadyFrozen !== null && (
        <p className="tiny">
          Chain currently reports:{" "}
          {alreadyFrozen ? <span className="pill danger">FROZEN</span> : <span className="pill ok">clear</span>}
        </p>
      )}

      {!wallet && (
        <p className="tiny muted" data-testid="observer-notice">
          {WRITE_DISABLED_HINT}: freeze, unfreeze and heartbeat are all signed writes.
        </p>
      )}

      {phase !== "confirming" && (
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="danger"
            ref={triggerRef}
            disabled={freezeControl.disabled}
            title={freezeControl.title}
            onClick={() => {
              setAcknowledged(false);
              setPhase("confirming");
              setReport(null);
            }}
          >
            Freeze this account
          </button>
          <button
            className="secondary"
            disabled={unfreezeControl.disabled}
            title={unfreezeControl.title}
            onClick={() => void run("unfreeze")}
          >
            Unfreeze
          </button>
          <button
            className="secondary"
            disabled={unfreezeControl.disabled}
            title={unfreezeControl.title}
            onClick={() => void run("unfreeze", true)}
          >
            Export Unfreeze XDR
          </button>
        </div>
      )}

      {phase === "confirming" && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="freeze-confirm-title"
            ref={dialogRef}
            tabIndex={-1}
          >
            <strong id="freeze-confirm-title">
              Confirm the freeze — this stops the agent immediately
            </strong>
            <p className="tiny">
              The agent will not be able to make any call that requires its authorization until the
              account is unfrozen. This will prompt your wallet to sign an <code>unfreeze</code>-able{" "}
              <code>freeze()</code> call on{" "}
              <span className="mono">{guard.slice(0, 10)}…</span>.
            </p>
            <div className="checkline">
              <input
                id="ack-freeze"
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <label htmlFor="ack-freeze">
                I understand this halts the agent&apos;s spending, and that undoing it needs a second
                signed <code>unfreeze()</code>.
              </label>
            </div>
            <div className="row">
              <button className="danger" disabled={!acknowledged} onClick={() => void run("freeze")}>
                Sign freeze
              </button>
              <button className="secondary" disabled={!acknowledged} onClick={() => void run("freeze", true)}>
                Export XDR
              </button>
              <button className="secondary" onClick={() => setPhase("idle")}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {(phase === "signing" || phase === "verifying") && (
        <div className="notice info">
          <strong>{phase === "signing" ? "Waiting for the wallet…" : "Verifying on chain…"}</strong>
          <span className="tiny">
            {phase === "signing"
              ? "Two signatures may be requested: one for the authorization entry, one for the transaction envelope."
              : "Re-reading status() to confirm the account's own view changed."}
          </span>
        </div>
      )}

      {error && <ErrorBlock title="The freeze could not be completed" detail={error} />}

      {report?.result.kind === "exported" && (
        <div className="modal-backdrop" onClick={() => { setReport(null); setPhase("idle"); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h2 style={{ margin: 0 }}>Exported Transaction XDR</h2>
              <button className="secondary" onClick={() => { setReport(null); setPhase("idle"); }}>Close</button>
            </div>
            <p className="tiny" style={{ marginBottom: "16px" }}>
              This unsigned transaction envelope is ready for external multi-sig signing.
            </p>
            <textarea
              readOnly
              value={report.result.kind === "exported" ? report.result.xdr : ""}
              style={{ width: "100%", height: "120px", marginBottom: "16px", fontSize: "12px", fontFamily: "monospace" }}
            />
            <div className="row">
              <button onClick={() => navigator.clipboard.writeText(report.result.kind === "exported" ? report.result.xdr : "")}>Copy to Clipboard</button>
              <button
                onClick={() => {
                  const blob = new Blob([report.result.kind === "exported" ? report.result.xdr : ""], { type: "text/plain" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `unsigned-${report.action}-${Date.now()}.tx`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download .tx
              </button>
            </div>
          </div>
        </div>
      )}

      {report && report.result.kind !== "exported" && (
        <div className={report.confirmed ? "notice info" : "error"}>
          <strong>
            {report.confirmed
              ? `${report.action === "freeze" ? "Freeze" : "Unfreeze"} confirmed on chain`
              : `${report.action === "freeze" ? "Freeze" : "Unfreeze"} NOT confirmed`}
          </strong>
          <span className="tiny">{report.note}</span>

          {report.result.kind === "submitted" && (
            <p className="tiny" style={{ marginTop: 6 }}>
              transaction {starLink(report.result.hash)} · included in ledger{" "}
              {report.result.ledger ?? "—"}
            </p>
          )}
          {report.result.kind === "refused" && (
            <p className="tiny" style={{ marginTop: 6 }}>
              Nothing was broadcast. Refused during {report.result.stage}:{" "}
              <span className="mono">{report.result.detail}</span>
            </p>
          )}
          {report.result.kind === "failed" && (
            <p className="tiny" style={{ marginTop: 6 }}>
              Transaction {starLink(report.result.hash)} was included and rejected:{" "}
              <span className="mono">{report.result.detail}</span>
            </p>
          )}

          {report.result.kind !== "submitted" && (
            <p className="tiny muted" style={{ marginTop: 6 }}>
              A refused call has no transaction hash by construction — it was never broadcast. That is
              the pre-flight path working, not a missing receipt.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
