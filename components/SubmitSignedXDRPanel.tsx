"use client";

import { useState } from "react";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, OutcomeList, starLink } from "./bits.tsx";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK } from "../lib/guard/network.ts";
import { announce } from "../lib/guard/useAnnounce.ts";

export function SubmitSignedXDRPanel() {
  const { server } = useGuard();
  const [xdr, setXdr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successHash, setSuccessHash] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setSuccessHash(null);
    try {
      const tx = TransactionBuilder.fromXDR(xdr.trim(), NETWORK.passphrase);
      // Wait, TransactionBuilder.fromXDR parses it. Then we submit it.
      const response = await server.sendTransaction(tx as any);
      if (response.status === "ERROR") {
        throw new Error(JSON.stringify(response.errorResult || response));
      }
      setSuccessHash(response.hash);
      announce("Externally signed transaction submitted to network");
      setXdr("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Submit Signed XDR</h2>
      <p className="tiny muted">
        Broadcast an externally assembled and signed transaction envelope. Use this for offline or
        multi-sig operations.
      </p>
      <textarea
        value={xdr}
        onChange={(e) => setXdr(e.target.value)}
        placeholder="Paste signed transaction XDR here (base64)"
        style={{ width: "100%", height: "80px", marginBottom: "12px", fontFamily: "monospace" }}
      />
      <div className="row">
        <button disabled={busy || !xdr.trim()} onClick={submit}>
          {busy ? "Submitting..." : "Submit to Network"}
        </button>
      </div>
      {error && <ErrorBlock title="Submission failed" detail={error} />}
      {successHash && (
        <div className="notice info" style={{ marginTop: "16px" }}>
          <strong>Transaction submitted — {starLink(successHash)}</strong>
        </div>
      )}
    </div>
  );
}
