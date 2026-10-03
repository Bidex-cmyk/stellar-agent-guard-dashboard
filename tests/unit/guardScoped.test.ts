/**
 * Per-guard state scoping: the key naming rule and the delete cascade.
 *
 * The isolation guarantee is the whole point — a draft or filter saved for one
 * guard must be unreachable from another, including across networks — so both
 * the positive round-trip and the negative cross-guard reads are pinned here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCOPED_STORAGE_BASES,
  SCOPED_STORAGE_PREFIX,
  clearGuardScopedState,
  clearScopedValue,
  loadScopedValue,
  saveScopedValue,
  scopedStorageKey,
  type ScopedOptions,
} from "../../lib/guard/guardScoped.ts";
import type { StorageLike } from "../../lib/guard/instance.ts";

const GUARD_A = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const GUARD_B = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    dump: () => Object.fromEntries(data),
  };
}

describe("the scoped key", () => {
  it("namespaces by base, network and guard address", () => {
    const key = scopedStorageKey("feedFilter", "testnet", GUARD_A);
    assert.equal(key, `${SCOPED_STORAGE_PREFIX}.feedFilter.testnet.${GUARD_A}`);
    assert.notEqual(key, scopedStorageKey("feedFilter", "mainnet", GUARD_A));
    assert.notEqual(key, scopedStorageKey("feedFilter", "testnet", GUARD_B));
    assert.notEqual(key, scopedStorageKey("policyDraft", "testnet", GUARD_A));
  });
});

describe("round-trip and corruption", () => {
  it("stores and retrieves a value", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, { verdict: "blocked" }, { storage });
    assert.deepEqual(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), {
      verdict: "blocked",
    });
  });

  it("returns null for a corrupt payload rather than throwing", () => {
    const storage = memoryStorage({
      [scopedStorageKey("feedFilter", "testnet", GUARD_A)]: "{nope",
    });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), null);
  });

  it("is inert without storage", () => {
    const options: ScopedOptions = { storage: null };
    assert.doesNotThrow(() => saveScopedValue("feedFilter", "testnet", GUARD_A, 1, options));
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, options), null);
  });
});

describe("cross-guard isolation", () => {
  it("keeps same-network, different-address entries apart", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, "A-blocked", { storage });
    saveScopedValue("feedFilter", "testnet", GUARD_B, "B-allowed", { storage });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), "A-blocked");
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_B, { storage }), "B-allowed");
  });

  it("keeps the same address on different networks apart", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, "testnet-view", { storage });
    saveScopedValue("feedFilter", "mainnet", GUARD_A, "mainnet-view", { storage });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), "testnet-view");
    assert.equal(loadScopedValue("feedFilter", "mainnet", GUARD_A, { storage }), "mainnet-view");
  });
});

describe("the delete cascade", () => {
  it("clears every known base for one guard on one network, and nothing else", () => {
    const storage = memoryStorage();
    for (const base of SCOPED_STORAGE_BASES) {
      saveScopedValue(base, "testnet", GUARD_A, `${base}-A`, { storage });
      saveScopedValue(base, "testnet", GUARD_B, `${base}-B`, { storage });
      saveScopedValue(base, "mainnet", GUARD_A, `${base}-mainnet`, { storage });
    }

    clearGuardScopedState("testnet", GUARD_A, { storage });

    for (const base of SCOPED_STORAGE_BASES) {
      assert.equal(loadScopedValue(base, "testnet", GUARD_A, { storage }), null, `${base} cleared`);
      assert.equal(
        loadScopedValue(base, "testnet", GUARD_B, { storage }),
        `${base}-B`,
        `${base} kept`,
      );
      assert.equal(
        loadScopedValue(base, "mainnet", GUARD_A, { storage }),
        `${base}-mainnet`,
        `${base} on another network kept`,
      );
    }
  });

  it("clearScopedValue removes exactly one key", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, "x", { storage });
    clearScopedValue("feedFilter", "testnet", GUARD_A, { storage });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), null);
  });
});
