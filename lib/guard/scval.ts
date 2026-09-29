/**
 * Small, isomorphic XDR/ledger helpers.
 *
 * Deliberately free of `node:crypto` and `Buffer`: this module runs in the
 * operator's browser (the dashboard has no server half), so hashing goes through
 * Web Crypto and every byte field is a `Uint8Array`.
 */

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/**
 * The Web Crypto implementation the hashing helpers run on.
 *
 * There is deliberately no `node:crypto` fallback: a `await import("node:crypto")`
 * is a bare `node:`-scheme specifier that webpack refuses to bundle for the
 * browser, which would break `ANALYZE=true next build --webpack` (the
 * @next/bundle-analyzer path). The runtime floor is Node 24 (`engines` in
 * package.json), and every supported browser exposes `crypto.subtle`, so the
 * global is the one implementation in all environments this module runs in.
 */
async function getSubtleCrypto(): Promise<SubtleCrypto> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "crypto.subtle is unavailable: hashing needs Web Crypto in this runtime",
    );
  }
  return subtle;
}

/** SHA-256 of arbitrary bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = await getSubtleCrypto();
  const digest = await subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 as raw bytes. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = await getSubtleCrypto();
  const digest = await subtle.digest("SHA-256", toArrayBuffer(bytes));
  return new Uint8Array(digest);
}

/**
 * `crypto.subtle` requires a real `ArrayBuffer`; a `Uint8Array` over a
 * `SharedArrayBuffer` or a subarray view is rejected, so copy into a fresh one.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A contract/account `Address` as the `ScVal` a contract parameter expects. */
export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/** An `i128` argument, kept as a bigint end to end so no cap loses precision. */
export function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/** A `u64` argument. */
export function u64ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "u64" });
}

/** A `u32` argument. */
export function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

/**
 * The guard's own persistent storage keys, as they exist in ledger state.
 *
 * A Rust `contracttype` enum is a vector of symbols on the wire
 * (`DataKey::Policy` → `[Symbol("Policy")]`), so these are built to match real
 * ledger state rather than as bare symbols.
 */
export function guardStorageLedgerKeys(guard: string): xdr.LedgerKey[] {
  const scAddress = new Address(guard).toScAddress();
  return (["Policy", "Window", "LastHeartbeat", "AdminFrozen"] as const).map((name) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: scAddress,
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
}

/** A stable identity for a `LedgerKey`, for de-duplicating a footprint. */
export function ledgerKeyId(key: xdr.LedgerKey): string {
  return bytesToHex(new Uint8Array(key.toXDR()));
}

/** A 32-byte hash in whatever shape a helper hands it back, as lowercase hex. */
export function hashToHex(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.replace(/^0x/, "").toLowerCase();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (value instanceof ArrayBuffer) return bytesToHex(new Uint8Array(value));
  const candidate = value as {
    value?: unknown;
    toXdrObject?: () => unknown;
    toJSON?: () => unknown;
  };
  // `xdr.Hash` wrappers carry the raw 32 bytes on `.value`; check it first so a
  // hash never falls through to the JSON heuristics below and come back null.
  if (candidate.value instanceof Uint8Array) return bytesToHex(candidate.value);
  if (candidate.value instanceof ArrayBuffer) return bytesToHex(new Uint8Array(candidate.value));
  if (typeof candidate.toXdrObject === "function") return hashToHex(candidate.toXdrObject());
  if (typeof candidate.toJSON === "function") {
    const rendered = candidate.toJSON();
    if (typeof rendered === "string") return hashToHex(rendered);
    if (rendered && typeof rendered === "object") {
      const record = rendered as Record<string, unknown>;
      return hashToHex(record["wasm"] ?? record["wasmHash"]);
    }
  }
  return null;
}

/** JSON with every bigint rendered exactly, as a decimal string. */
export function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}
