/**
 * Reading the account facts the multisig tracker needs, off Horizon.
 *
 * The tracker's arithmetic lives in `multisig.ts` as pure functions; this
 * module is the seam that fetches what those functions consume — the account's
 * signer list (weights) and its threshold settings — from the Horizon account
 * endpoint, plus the signature list actually on a pending envelope.
 *
 * Like every read in this dashboard, a failed fetch is an error, never a
 * default: a tracker that rendered "0 of 0" because Horizon was unreachable
 * would look identical to a genuinely threshold-less account. `ReadResult`
 * keeps the failure visible.
 *
 * The Horizon server is constructed lazily from the deployment's network
 * constant, exactly as `chain.ts` constructs the Soroban RPC server. No
 * `Buffer` and no `node:crypto`: this runs in the browser, so hex encoding and
 * strkey decoding go through the same helpers the rest of `lib/guard` uses.
 */

import { Horizon, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";
import type { EnvelopeSignature, MultisigSigner, MultisigThresholds } from "./multisig.ts";

export type HorizonReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function createHorizonServer(horizonUrl?: string): Horizon.Server {
  return new Horizon.Server(horizonUrl ?? defaultHorizonUrl());
}

/**
 * The Horizon base URL for the dashboard's pinned network.
 *
 * The network constant names the passphrase; the Horizon host is derived from
 * the same testnet deployment rather than configurable, so the tracker cannot
 * be pointed at an account from a different network by accident.
 */
export function defaultHorizonUrl(): string {
  // The deployment is pinned to testnet; keep the derivation in one place so a
  // pubnet deployment changes it exactly once.
  return "https://horizon-testnet.stellar.org";
}

interface HorizonSignerRecord {
  key: string;
  weight: number;
}

interface HorizonAccountRecord {
  signers: HorizonSignerRecord[];
  thresholds: MultisigThresholds;
}

/** Labels are derived deterministically so tests and UI agree on them. */
export function defaultSignerLabel(index: number): string {
  return `Signer ${index + 1}`;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read the guarded account's signers and thresholds from Horizon.
 *
 * Signers carrying weight 0 are kept (a disabled signer is real account state
 * worth showing) and order follows Horizon's response, master key first.
 */
export async function readAccountSigners(
  server: Horizon.Server,
  accountId: string,
): Promise<HorizonReadResult<{ signers: MultisigSigner[]; thresholds: MultisigThresholds }>> {
  try {
    const record = (await server.accounts().accountId(accountId).call()) as HorizonAccountRecord;
    const signers: MultisigSigner[] = record.signers.map((signer, index) => ({
      key: signer.key,
      weight: signer.weight,
      label: defaultSignerLabel(index),
    }));
    return {
      ok: true,
      value: { signers, thresholds: record.thresholds },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Extract the signatures present on a transaction envelope.
 *
 * The envelope is decoded locally — no network call — because the signatures
 * to count are the ones already on the envelope, not whatever the network has
 * seen. A decorated signature carries only a 4-byte *hint* of its signer (the
 * last 4 bytes of the Ed25519 public key), which is enough to match the
 * signature to an account signer but not enough to reconstruct the `G…` key;
 * the returned records therefore carry `hint:<hex>` identities and the caller
 * matches them against `signerHint()` for each account signer.
 */
export function readEnvelopeSignatures(
  envelopeXdr: string,
  passphrase: string = NETWORK.passphrase,
): HorizonReadResult<EnvelopeSignature[]> {
  try {
    const envelope = TransactionBuilder.fromXDR(envelopeXdr.trim(), passphrase);
    const signatures: EnvelopeSignature[] = [];
    for (const decorated of envelope.signatures) {
      // `hint` is the SDK's `SignatureHint` wrapper; `.value` is the raw 4 bytes.
      const hint = (decorated.hint as unknown as { value: Uint8Array }).value;
      signatures.push({ signer: `hint:${toHex(hint)}` });
    }
    return { ok: true, value: signatures };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The 4-byte signature hint of an account signer, for envelope matching. */
export function signerHint(signerKey: string): string | null {
  try {
    return toHex(StrKey.decodeEd25519PublicKey(signerKey).slice(-4));
  } catch {
    // Not a `G…` account key (a contract, a hash signer, or a typo): it cannot
    // match an Ed25519 signature hint.
    return null;
  }
}

/**
 * Signatures on the envelope that no current account signer claims.
 *
 * Horizon hints can collide (4 bytes of a 32-byte key) across enormous signer
 * sets, so a match here is the tracker's reading of the facts rather than a
 * cryptographic identification — the network itself does the exact check at
 * submission, and this list only informs the display.
 */
export function unmatchedSignatures(
  signatures: readonly EnvelopeSignature[],
  signers: readonly MultisigSigner[],
): string[] {
  const known = new Set(
    signers
      .map((signer) => signerHint(signer.key))
      .filter((hint): hint is string => hint !== null)
      .map((hint) => `hint:${hint}`),
  );
  return signatures
    .map((signature) => signature.signer)
    .filter((signer) => !known.has(signer));
}
