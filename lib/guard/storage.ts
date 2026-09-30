import { scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * The guard's persistent storage keys, as they exist on the ledger. A Rust
 * `contracttype` enum variant is stored as `Vec[Symbol("Name")]`, but the
 * decoder only needs to know which logical key it was asked for.
 */
export type DataKey = "Policy" | "Window" | "DeadManSwitch" | "Paused";

export interface DecodedStorage<T> {
  /** True when the entry decoded into a known contract-data value. */
  decoded: boolean;
  /** Remaining lifetime in ledgers, when a Soroban TTL entry was supplied. */
  ttl?: number;
  dataKey?: DataKey;
  value?: T | "Uninitialized";
}

const uninitialized = <T>(): DecodedStorage<T> => ({ decoded: false, value: "Uninitialized" });

/**
 * Accept either a full `LedgerEntry` (what `getLedgerEntries` returns) or a
 * bare `LedgerEntryData`, so callers can pass whichever the RPC handed them.
 */
function readEntryData(xdrBase64: string): xdr.LedgerEntryData | null {
  try {
    return xdr.LedgerEntry.fromXdr(xdrBase64, "base64").data;
  } catch {
    try {
      return xdr.LedgerEntryData.fromXdr(xdrBase64, "base64");
    } catch {
      return null;
    }
  }
}

/**
 * Decode one contract storage footprint into a typed value.
 *
 * Missing or uninitialized storage decodes to an `Uninitialized` marker rather
 * than throwing, so a caller can render "not set" without a try/catch. A TTL
 * entry (Soroban keeps it as a sibling `LedgerEntryData.ttl`) reports the
 * remaining ledger lifetime instead.
 */
export function decodeStorageFootprint<T = unknown>(
  xdrBase64: string,
  dataKey: DataKey,
): DecodedStorage<T> {
  if (!xdrBase64) return uninitialized<T>();

  const data = readEntryData(xdrBase64);
  if (!data) return uninitialized<T>();

  if (data.type === "ttl") {
    return { decoded: true, ttl: data.ttl.liveUntilLedgerSeq };
  }

  if (data.type !== "contractData") return uninitialized<T>();

  const value = scValToNative(data.contractData.val) as T;
  return { decoded: true, dataKey, value };
}
