"use client";

/**
 * The hardware-wallet signing guide modal (issue #99).
 *
 * Appears over the console whenever a write is being signed and stays up until
 * the signature is confirmed, giving the operator the checklist for approving a
 * Soroban call on a Ledger and showing the transaction hash in a large, grouped,
 * monospace block to compare against the device. It reads the in-flight signing
 * context straight from `hardwareGuide` via `useSyncExternalStore`, so its
 * lifecycle is exactly the store's: it appears when `submit.ts` opens a session
 * and dismisses itself, with no timer of its own, the moment that session clears.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { formatHashForDevice, hardwareGuide } from "../lib/guard/hardwareGuide.ts";
import { short } from "./bits.tsx";

/** The steps, wording tuned for a Stellar-app Soroban flow on a Nano/Flex/X. */
const LEDGER_STEPS: readonly string[] = [
  "Open the Stellar app on your Ledger and stay on its main screen.",
  "When prompted, allow Contract Data (Hash signing) — and Blind signing only if the app requests it.",
  "On the device, confirm the Contract ID matches the one shown below.",
  "Confirm the Method matches the function shown below.",
  "Compare the full transaction hash digit-for-digit with the grouped value below.",
  "Only then press both buttons on the device to approve the signature.",
];

export function HardwareWalletGuide() {
  const snapshot = useSyncExternalStore(
    hardwareGuide.subscribe,
    hardwareGuide.getSnapshot,
    hardwareGuide.getSnapshot,
  );
  const dialogRef = useRef<HTMLDivElement>(null);

  // The dialog appears only while signing; pull focus into it so a keyboard or
  // screen-reader operator reaches the checklist immediately.
  useEffect(() => {
    if (snapshot.active) dialogRef.current?.focus();
  }, [snapshot.active]);

  if (!snapshot.active || snapshot.session === null) return null;
  const { contractId, method, txHash } = snapshot.session;
  const formatted = formatHashForDevice(txHash);

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hw-guide-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <strong id="hw-guide-title">Confirm on your Ledger</strong>
        <p className="tiny muted">
          This transaction is waiting for your hardware wallet. Verify every detail on the device
          before you approve — once signed, it is broadcast and cannot be recalled.
        </p>

        <div className="grid">
          <div className="stat">
            <div className="k">Contract</div>
            <div className="v small mono" title={contractId}>
              {short(contractId, 8, 6)}
            </div>
          </div>
          <div className="stat">
            <div className="k">Method</div>
            <div className="v small mono">{method}</div>
          </div>
        </div>

        <div className="stack" style={{ marginTop: 10 }}>
          <span className="lbl">Transaction hash</span>
          <p
            className="mono"
            style={{
              fontSize: 20,
              wordBreak: "break-all",
              lineHeight: 1.5,
              letterSpacing: "0.06em",
            }}
            aria-live="polite"
          >
            {txHash === null ? "Preparing transaction…" : formatted || "—"}
          </p>
        </div>

        <ol className="tiny" style={{ marginTop: 8, paddingLeft: 20 }}>
          {LEDGER_STEPS.map((step) => (
            <li key={step} style={{ marginBottom: 4 }}>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
