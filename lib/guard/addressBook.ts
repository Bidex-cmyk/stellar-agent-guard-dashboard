/**
 * The operator's address book: human-readable nicknames for Stellar addresses.
 *
 * `GA7Q…` and `CA3D…` are effectively unreadable once there are more than two of
 * them, and mistaking one for another when editing a policy allowlist is exactly
 * the kind of error a spend cap cannot catch. This module stores the
 * address-to-label mapping the operator curates, so the UI can render
 * "Soroswap Router (CA3D…12EF)" wherever an address appears.
 *
 * The persistence and validation seam mirrors `txHistory.ts` and `instance.ts`:
 * reads and writes are best-effort (private-mode and corrupt payloads degrade to
 * an empty book, never a crash), every stored address is validated with the SDK
 * so a bad import cannot poison the book, and `StorageLike` is injectable for
 * tests.
 */

import { Address } from "@stellar/stellar-sdk";

export interface Contact {
  /** A valid Stellar account (`G…`) or contract (`C…`) address. Identity. */
  address: string;
  /** The operator's own label, e.g. "Treasury Multisig". */
  label: string;
  /** ISO 8601 timestamp of when the contact was first added. */
  addedAt: string;
}

export const ADDRESS_BOOK_STORAGE_KEY = "stellar-agent-guard-dashboard.addressBook.v1";

/** Cap on stored contacts, so a bad import cannot grow without bound. */
export const ADDRESS_BOOK_LIMIT = 500;

/** The subset of `Storage` the store needs, so tests can inject a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A well-formed account (`G…`) or contract (`C…`) address, checked with the SDK. */
export function isValidAddress(value: string): boolean {
  try {
    Address.fromString(value.trim());
    return true;
  } catch {
    return false;
  }
}

function isContact(value: unknown): value is Contact {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Contact>;
  return (
    typeof entry.address === "string" &&
    typeof entry.label === "string" &&
    isValidAddress(entry.address) &&
    entry.label.trim() !== ""
  );
}

const listeners = new Set<() => void>();

/** Watch for contact changes made anywhere in this tab (add, edit, delete, import). */
export function subscribeAddressBook(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** The stored book, validated and de-duplicated by address. A corrupt payload yields an empty book. */
export function loadAddressBook(storage: StorageLike | null = defaultStorage()): Contact[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(ADDRESS_BOOK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: Contact[] = [];
    for (const entry of parsed) {
      if (!isContact(entry) || seen.has(entry.address)) continue;
      seen.add(entry.address);
      out.push(entry);
    }
    return out.slice(0, ADDRESS_BOOK_LIMIT);
  } catch {
    return [];
  }
}

function persist(contacts: Contact[], storage: StorageLike | null): Contact[] {
  if (storage) {
    try {
      storage.setItem(ADDRESS_BOOK_STORAGE_KEY, JSON.stringify(contacts));
    } catch {
      // A private-mode write must not interrupt the operator.
    }
  }
  return contacts;
}

/**
 * Add a contact, or relabel an existing address.
 *
 * Re-adding a known address updates its label in place (keeping the original
 * `addedAt`) rather than creating a duplicate: an address has one identity in
 * the book. Throws on an invalid address or empty label so the UI can surface
 * the reason instead of silently dropping it.
 */
export function upsertContact(
  input: { address: string; label: string },
  storage: StorageLike | null = defaultStorage(),
): Contact[] {
  const address = input.address.trim();
  const label = input.label.trim();
  if (!isValidAddress(address)) {
    throw new Error(
      `"${address || "(empty)"}" is not a valid Stellar address (a G… or C… account).`,
    );
  }
  if (label === "") {
    throw new Error("A contact needs a label.");
  }
  const existing = loadAddressBook(storage);
  const prior = existing.find((contact) => contact.address === address);
  const next = prior
    ? existing.map((contact) => (contact.address === address ? { ...contact, label } : contact))
    : [{ address, label, addedAt: new Date().toISOString() }, ...existing].slice(
        0,
        ADDRESS_BOOK_LIMIT,
      );
  notify();
  return persist(next, storage);
}

/** Remove a contact by address. Removing an unknown address is a no-op. */
export function deleteContact(
  address: string,
  storage: StorageLike | null = defaultStorage(),
): Contact[] {
  const trimmed = address.trim();
  const existing = loadAddressBook(storage);
  if (!existing.some((contact) => contact.address === trimmed)) return existing;
  notify();
  return persist(
    existing.filter((contact) => contact.address !== trimmed),
    storage,
  );
}

/** The friendly label for an address, or `null` when it is not in the book. */
export function lookupLabel(
  address: string,
  storage: StorageLike | null = defaultStorage(),
): string | null {
  const trimmed = address.trim();
  if (trimmed === "") return null;
  return loadAddressBook(storage).find((contact) => contact.address === trimmed)?.label ?? null;
}

/** The book as portable JSON — an array of `{ address, label }`, the fields that matter to another install. */
export function exportAddressBook(contacts: Contact[]): string {
  return `${JSON.stringify(
    contacts.map((contact) => ({ address: contact.address, label: contact.label })),
    null,
    2,
  )}\n`;
}

/**
 * Parse an exported book back into contacts.
 *
 * Every address is validated and every label required, so a corrupted or
 * hand-edited import is rejected with the offending index rather than half
 * landing in the book.
 */
export function parseAddressBook(source: string): Contact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("The address book must be a JSON array of contacts.");
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Contact ${index + 1} must be an object.`);
    }
    const value = entry as Record<string, unknown>;
    const address = typeof value.address === "string" ? value.address.trim() : "";
    const label = typeof value.label === "string" ? value.label.trim() : "";
    if (!isValidAddress(address)) {
      throw new Error(
        `Contact ${index + 1}: "${address || "(empty)"}" is not a valid Stellar address.`,
      );
    }
    if (label === "") {
      throw new Error(`Contact ${index + 1}: a label is required.`);
    }
    if (seen.has(address)) {
      throw new Error(`Contact ${index + 1}: duplicate address ${address}.`);
    }
    seen.add(address);
    return { address, label, addedAt: new Date().toISOString() };
  });
}

export type ImportTally = { added: number; updated: number; total: number };

/**
 * Merge an imported book into the current one, additively.
 *
 * Existing contacts not present in the import are kept — an import should not
 * silently delete addresses the operator already relied on. On an address
 * collision the imported label wins.
 */
export function mergeAddressBook(
  current: Contact[],
  incoming: Contact[],
  storage: StorageLike | null = defaultStorage(),
): ImportTally {
  const byAddress = new Map(current.map((contact) => [contact.address, contact]));
  let added = 0;
  let updated = 0;
  for (const contact of incoming) {
    const prior = byAddress.get(contact.address);
    if (prior === undefined) {
      byAddress.set(contact.address, { ...contact, addedAt: contact.addedAt });
      added += 1;
    } else if (prior.label !== contact.label) {
      byAddress.set(contact.address, { ...prior, label: contact.label });
      updated += 1;
    }
  }
  const merged = [...byAddress.values()].slice(0, ADDRESS_BOOK_LIMIT);
  notify();
  persist(merged, storage);
  return { added, updated, total: merged.length };
}
