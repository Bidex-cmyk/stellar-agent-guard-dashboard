/**
 * Per-guard, per-network persistence keys.
 *
 * An operator running several guards wants each one's drafts and filters kept
 * apart: the recipient list being edited for guard A must not appear when the
 * selector is moved to guard B, and a contract-address search typed against one
 * feed must not silently filter the other. This module owns the one naming rule
 * that makes that true — the storage key for a piece of guard state is
 * `…scoped.v1.<base>.<network>.<guard>` — plus the cascade that clears every
 * scoped key for a guard when it is deleted.
 *
 * The guard address is part of the key on purpose: the same address on two
 * networks is two deployments, so `network` is in the key too. Because the key
 * is derived from the *active* guard, a component reading through `useGuard`
 * gets the right bucket for free and a stale key is unreachable.
 *
 * The persistence seam mirrors `instance.ts`/`layoutStore.ts`: injectable
 * storage, best-effort writes, corruption-tolerant reads.
 */

import { NETWORK } from "./network.ts";
import type { StorageLike } from "./instance.ts";

/** The prefix shared by every scoped key, versioned so a shape change is explicit. */
export const SCOPED_STORAGE_PREFIX = "stellar-agent-guard-dashboard.scoped.v1";

/**
 * The pieces of state that are remembered per guard. Kept as a closed list so
 * `clearGuardScopedState` can enumerate what to remove on delete — an open-ended
 * key space could not be cleaned up without a full-storage scan.
 */
export const SCOPED_STORAGE_BASES = ["feedFilter", "policyDraft"] as const;

export type ScopedBase = (typeof SCOPED_STORAGE_BASES)[number];

export interface ScopedOptions {
  storage?: StorageLike | null;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolve(options?: ScopedOptions): StorageLike | null {
  return options?.storage === undefined ? defaultStorage() : options.storage;
}

/**
 * The key for one piece of guard state. Deterministic, so a test (or the delete
 * cascade) can reconstruct it without the component that wrote it.
 */
export function scopedStorageKey(base: string, network: string, guard: string): string {
  return `${SCOPED_STORAGE_PREFIX}.${base}.${network}.${guard}`;
}

/** Read a scoped value, or `null` when nothing valid is stored. */
export function loadScopedValue<T>(
  base: string,
  network: string,
  guard: string,
  options?: ScopedOptions,
): T | null {
  const storage = resolve(options);
  if (!storage) return null;
  try {
    const raw = storage.getItem(scopedStorageKey(base, network, guard));
    if (raw === null || raw === "") return null;
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt payload is a missed filter, not a broken console.
    return null;
  }
}

/** Persist a scoped value. Private-mode write failures are not worth surfacing. */
export function saveScopedValue<T>(
  base: string,
  network: string,
  guard: string,
  value: T,
  options?: ScopedOptions,
): void {
  const storage = resolve(options);
  if (!storage) return;
  try {
    storage.setItem(scopedStorageKey(base, network, guard), JSON.stringify(value));
  } catch {
    // Private mode or quota: the value stays in memory for this session.
  }
}

/** Remove one scoped value. */
export function clearScopedValue(
  base: string,
  network: string,
  guard: string,
  options?: ScopedOptions,
): void {
  const storage = resolve(options);
  if (!storage) return;
  const key = scopedStorageKey(base, network, guard);
  try {
    if (typeof storage.removeItem === "function") storage.removeItem(key);
    else storage.setItem(key, "");
  } catch {
    // Best-effort.
  }
}

/**
 * Remove every known scoped key for a guard on a network.
 *
 * Called when an instance is deleted, so re-adding the same address later starts
 * clean rather than restoring drafts and filters the operator thought they had
 * discarded with the guard.
 */
export function clearGuardScopedState(
  network: string,
  guard: string,
  options?: ScopedOptions,
): void {
  for (const base of SCOPED_STORAGE_BASES) {
    clearScopedValue(base, network, guard, options);
  }
}

/** The network this build scopes state under, re-exported for callers. */
export const SCOPED_NETWORK = NETWORK.name;
