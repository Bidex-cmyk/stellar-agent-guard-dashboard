"use client";

/**
 * The multisig pending-approval tracker (#147).
 *
 * An enterprise account configured with Stellar's native multi-sig holds admin
 * transactions in a pending state until the required co-signers have signed the
 * envelope. This panel takes one pasted envelope XDR, reads the account's
 * signer weights and thresholds from Horizon, and shows exactly where the
 * approval stands: collected weight against the requirement, per-signer status,
 * and a one-click copy of the hash and envelope for the remaining co-signers.
 *
 * The panel is a thin view over `multisig.ts` (the arithmetic) and
 * `multisigRead.ts` (the reads): a failed Horizon read renders an error block,
 * never a zero, and a malformed envelope is reported as malformed rather than
 * silently treated as unsigned.
 */

import { useCallback, useState } from "react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK } from "../lib/guard/network.ts";
import { bytesToHex } from "../lib/guard/scval.ts";
import {
  approvalPercent,
  approvalSummary,
  evaluateApprovalState,
  pendingSigners,
  type MultisigApprovalState,
} from "../lib/guard/multisig.ts";
import {
  createHorizonServer,
  readAccountSigners,
  readEnvelopeSignatures,
  signerHint,
  unmatchedSignatures,
} from "../lib/guard/multisigRead.ts";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock } from "./bits.tsx";
import { announce } from "../lib/guard/useAnnounce.ts";

interface TrackerReport {
  /** The envelope's hash, as the network would compute it. */
  hash: string | null;
  envelopeXdr: string;
  state: MultisigApprovalState;
  /** Signatures on the envelope that no current account signer claims. */
  unmatched: string[];
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch {
      return false;
    }
  }
}

export function MultisigTracker() {
  const { guard } = useGuard();
  const [xdr, setXdr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<TrackerReport | null>(null);
  const [copied, setCopied] = useState<"hash" | "xdr" | null>(null);

  const analyse = useCallback(async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const trimmed = xdr.trim();
      if (trimmed.length === 0) {
        setError("Paste the pending transaction envelope XDR to track.");
        return;
      }

      // The account whose signers and thresholds decide the envelope's fate:
      // the guarded smart account is a contract, so its multisig configuration
      // lives on the *source account* the envelope is signed against — the
      // enterprise account configured for co-signing.
      const envelope = TransactionBuilder.fromXDR(trimmed, NETWORK.passphrase);
      const hash = bytesToHex(envelope.hash());
      const sourceAccount = (envelope as unknown as { source: string }).source;

      const server = createHorizonServer();
      const account = await readAccountSigners(server, sourceAccount);
      if (!account.ok) {
        setError(
          `Could not read the signers and thresholds of ${sourceAccount} from Horizon: ${account.error}`,
        );
        return;
      }

      const signatures = readEnvelopeSignatures(trimmed);
      if (!signatures.ok) {
        setError(`Could not decode signatures from the envelope: ${signatures.error}`);
        return;
      }

      // Translate hint-carried envelope signatures into the signer identities
      // the tracker compares, by matching each hint against the account's
      // signers (see `multisigRead.ts` for why only hints are available).
      const hintToSigner = new Map<string, string>();
      for (const signer of account.value.signers) {
        const hint = signerHint(signer.key);
        if (hint !== null) hintToSigner.set(`hint:${hint}`, signer.key);
      }
      const matched = signatures.value.map((signature) => ({
        signer: hintToSigner.get(signature.signer) ?? signature.signer,
      }));

      const state = evaluateApprovalState({
        signers: account.value.signers,
        thresholds: account.value.thresholds,
        signatures: matched,
      });
      const unmatched = unmatchedSignatures(signatures.value, account.value.signers);

      setReport({ hash, envelopeXdr: trimmed, state, unmatched });
      announce(
        state.ready
          ? "Multisig envelope has enough signatures to submit"
          : `Multisig envelope pending: ${state.collectedWeight} of ${state.requiredWeight} weight collected`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [xdr]);

  const doCopy = async (kind: "hash" | "xdr") => {
    if (!report) return;
    const text = kind === "hash" ? (report.hash ?? "") : report.envelopeXdr;
    const ok = await copyText(text);
    setCopied(ok ? kind : null);
    if (ok) {
      announce(kind === "hash" ? "Transaction hash copied" : "Envelope XDR copied");
      window.setTimeout(() => setCopied(null), 1500);
    }
  };

  return (
    <div className="panel">
      <h2>Multisig approvals</h2>
      <p className="tiny muted">
        Accounts configured with Stellar multi-signature thresholds hold an admin transaction in
        pending state until the required co-signers sign the envelope. Paste the pending envelope
        XDR to see the collected signature weight against the threshold and who is still to sign.
      </p>

      <label className="field">
        <span className="lbl">Pending transaction envelope (base64 XDR)</span>
        <textarea
          value={xdr}
          onChange={(event) => setXdr(event.target.value)}
          placeholder="AAAAAgAAAAD…"
          style={{ height: 80 }}
          aria-label="Pending transaction envelope XDR"
        />
      </label>

      <div className="row">
        <button onClick={() => void analyse()} disabled={busy || xdr.trim().length === 0}>
          {busy ? "Reading account…" : "Check approvals"}
        </button>
      </div>

      {error && <ErrorBlock title="The envelope could not be tracked" detail={error} />}

      {report && (
        <>
          <div className="notice info" style={{ marginTop: 10 }}>
            <strong>{report.state.ready ? "Ready to submit" : "Pending co-signatures"}</strong>
            <span className="tiny">{approvalSummary(report.state)}</span>
            <div
              role="progressbar"
              aria-valuenow={approvalPercent(report.state)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Collected signature weight"
              style={{
                marginTop: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--panel-2)",
                border: "1px solid var(--line)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${approvalPercent(report.state)}%`,
                  height: "100%",
                  background: report.state.ready ? "var(--ok)" : "var(--accent)",
                }}
              />
            </div>
          </div>

          {report.hash && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="mono tiny" title={report.hash}>
                hash {report.hash.slice(0, 12)}…{report.hash.slice(-6)}
              </span>
              <button className="secondary" onClick={() => void doCopy("hash")}>
                {copied === "hash" ? "Copied" : "Copy hash"}
              </button>
              <button className="secondary" onClick={() => void doCopy("xdr")}>
                {copied === "xdr" ? "Copied" : "Copy envelope XDR"}
              </button>
            </div>
          )}

          <p className="tiny muted" style={{ marginTop: 8 }}>
            Pass the hash and envelope to the remaining co-signers — each reviews and signs the same
            envelope, and only then can it be submitted.
          </p>

          {report.unmatched.length > 0 && (
            <div className="notice">
              <strong>{report.unmatched.length} signature(s) match no current account signer</strong>
              <span className="tiny">
                The envelope carries signatures whose hint does not match any signer Horizon lists
                for the source account. The network would not count them either; they may be from
                removed signers.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
