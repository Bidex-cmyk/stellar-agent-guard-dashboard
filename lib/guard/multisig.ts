/**
 * Multi-signature approval tracking for admin transactions.
 *
 * Enterprise deployments configure the guarded account with Stellar's native
 * multi-sig: several co-signers, each carrying a weight, and threshold values
 * (`med_threshold` for ordinary operations) that a transaction's collected
 * signature weight must meet before the network will accept it. An admin
 * transaction submitted by one signer therefore sits *pending* — included
 * nowhere, effective nowhere — until enough co-signers have signed the same
 * envelope.
 *
 * Everything in this module is pure arithmetic over data the Horizon account
 * endpoint and the transaction envelope already carry: it never signs, never
 * broadcasts, and never invents a signature. The tracker's job is to answer one
 * question honestly — *is this envelope submittable yet, and who is holding it
 * up?* — from the facts on the envelope and the account.
 *
 * Types here deliberately mirror the shapes Horizon returns
 * (`ServerApi.AccountRecordSigners`, `HorizonApi.AccountThresholds`) rather
 * than wrapping them, so a caller can pass Horizon's response straight in and
 * the test can build fixtures without a network.
 */

/** One signer of the guarded account, as Horizon's account endpoint reports it. */
export interface MultisigSigner {
  /** The `G…` account that can co-sign. */
  key: string;
  /** The weight this signer's signature contributes. 0 disables the signer. */
  weight: number;
  /**
   * The operator's name for the signer ("Admin 1", "Ops", …). Displayed in the
   * tracker so co-signers can be told apart without decoding strkeys.
   */
  label: string;
}

/** The account's signature thresholds, as Horizon reports them. */
export interface MultisigThresholds {
  low_threshold: number;
  med_threshold: number;
  high_threshold: number;
}

/** A signature present on a pending envelope. */
export interface EnvelopeSignature {
  /** The `G…` account that produced the signature. */
  signer: string;
}

/**
 * The tracker's verdict on one pending envelope.
 *
 * `ready` is the only word for "the network will accept this now". A pending
 * state below threshold is *not* an error — it is the normal life of a
 * multisig transaction — so no failure semantics attach to it.
 */
export interface MultisigApprovalState {
  /** Total weight of the signatures actually on the envelope. */
  collectedWeight: number;
  /** The threshold this transaction must meet. */
  requiredWeight: number;
  /** `true` only when `collectedWeight >= requiredWeight`. */
  ready: boolean;
  /** Per-signer status, in the account's signer order. */
  signers: SignerStatus[];
}

/** Where one signer stands on a pending envelope. */
export interface SignerStatus {
  key: string;
  label: string;
  weight: number;
  /** The signature status of this signer. */
  status: "signed" | "pending";
  /**
   * Weight this signer would add by signing, capped at the threshold: once the
   * requirement is met the surplus is not "needed" any more. `null` when the
   * signer has already signed.
   */
  weightNeeded: number | null;
}

/**
 * Evaluate a pending envelope against the account's signers and thresholds.
 *
 * Rules:
 *  - A signature on the envelope counts only when it belongs to an *account
 *    signer* — a stray signature from a removed key contributes nothing, which
 *    is exactly what the network would decide.
 *  - Zero-weight signers exist on accounts but are disabled: they cannot add
 *    weight, so they are shown as pending with `weightNeeded: 0` rather than
 *    silently omitted.
 *  - The threshold is `med_threshold` — the one ordinary admin operations
 *    (`set_policy`, `freeze`, `unfreeze`) are authorized against. A threshold
 *    of 0 means the source account alone suffices; a single-signed envelope is
 *    then ready by definition.
 */
export function evaluateApprovalState(params: {
  signers: readonly MultisigSigner[];
  thresholds: MultisigThresholds;
  signatures: readonly EnvelopeSignature[];
  /** Which threshold governs. Admin writes are medium-threshold operations. */
  thresholdLevel?: "low" | "med" | "high";
}): MultisigApprovalState {
  const { signers: accountSigners, thresholds, signatures } = params;
  const level = params.thresholdLevel ?? "med";
  const requiredWeight =
    level === "low"
      ? thresholds.low_threshold
      : level === "high"
        ? thresholds.high_threshold
        : thresholds.med_threshold;

  const signedKeys = new Set(signatures.map((signature) => signature.signer));

  let collectedWeight = 0;
  const signers: SignerStatus[] = accountSigners.map((signer) => {
    const signed = signedKeys.has(signer.key);
    signedKeys.delete(signer.key);
    if (signed && signer.weight > 0) {
      collectedWeight += signer.weight;
      return {
        key: signer.key,
        label: signer.label,
        weight: signer.weight,
        status: "signed",
        weightNeeded: null,
      };
    }
    const remaining = Math.max(0, requiredWeight - collectedWeight);
    return {
      key: signer.key,
      label: signer.label,
      weight: signer.weight,
      status: signed ? "signed" : "pending",
      // A disabled (weight-0) signer cannot help reach the threshold.
      weightNeeded: signer.weight > 0 ? Math.min(signer.weight, remaining) : 0,
    };
  });

  // Signatures from keys that are no longer account signers cannot contribute;
  // the network validates signatures against the account's current signer set,
  // so collected weight above is deliberately not inflated by them.

  return {
    collectedWeight,
    requiredWeight,
    ready: requiredWeight > 0 ? collectedWeight >= requiredWeight : true,
    signers,
  };
}

/**
 * Who still needs to sign, in the order that reaches the threshold soonest.
 *
 * Returned as signer keys so the UI can render "waiting on" without re-deriving
 * it, and capped at exactly the signers whose signature could still move the
 * envelope towards the threshold.
 */
export function pendingSigners(state: MultisigApprovalState): string[] {
  if (state.ready) return [];
  let remaining = state.requiredWeight - state.collectedWeight;
  const waiting: string[] = [];
  for (const signer of state.signers) {
    if (remaining <= 0) break;
    if (signer.status === "pending" && signer.weight > 0) {
      waiting.push(signer.key);
      remaining -= signer.weight;
    }
  }
  return waiting;
}

/** The canonical summary line the tracker displays. */
export function approvalSummary(state: MultisigApprovalState): string {
  const who = state.signers
    .map((signer) => `${signer.label} [${signer.status === "signed" ? "Signed" : "Pending"}]`)
    .join(", ");
  return `Collected weight ${state.collectedWeight} of ${state.requiredWeight} required (${who})`;
}

/**
 * The share of the threshold collected, as 0–100 for a progress bar.
 *
 * The ceiling is the threshold, not the account's total weight: extra surplus
 * signatures should not read as "more than done". A threshold of 0 is complete
 * by definition and returns 100.
 */
export function approvalPercent(state: MultisigApprovalState): number {
  if (state.requiredWeight <= 0) return 100;
  return Math.min(100, Math.round((state.collectedWeight / state.requiredWeight) * 100));
}
