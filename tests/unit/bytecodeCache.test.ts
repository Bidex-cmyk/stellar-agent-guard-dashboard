import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  getCachedByteLength,
  getCachedHash,
  invalidateCachedHash,
  setCachedHash,
} from "../../lib/guard/bytecodeCache.ts";

// The cache prefers `sessionStorage` when it exists (browsers) and falls back to
// an in-process store otherwise. Tests install a minimal in-memory replacement
// so the persisted entries can be inspected and reset between cases.
const backing = new Map<string, string>();

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem: (key: string): string | null => backing.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      backing.set(key, value);
    },
    removeItem: (key: string): void => {
      backing.delete(key);
    },
    clear: (): void => {
      backing.clear();
    },
    key: (index: number): string | null => Array.from(backing.keys())[index] ?? null,
    get length(): number {
      return backing.size;
    },
  },
});

const NETWORK = "Test SDF Network ; September 2015";
const OTHER_NETWORK = "Public Global Stellar Network ; September 2015";
const HASH = "a".repeat(64);

const contract = (index: number) => `C${String(index).padStart(3, "0")}`;

beforeEach(() => {
  backing.clear();
});

afterEach(() => {
  mock.timers.reset();
});

test("round-trips a hash keyed by network and contract id", () => {
  setCachedHash(NETWORK, contract(0), HASH, 4096);

  assert.equal(getCachedHash(NETWORK, contract(0)), HASH);
  assert.equal(getCachedByteLength(NETWORK, contract(0)), 4096);
  // A different network or contract is a different cache key entirely.
  assert.equal(getCachedHash(OTHER_NETWORK, contract(0)), null);
  assert.equal(getCachedHash(NETWORK, contract(1)), null);
});

test("entries expire once the one-hour TTL has elapsed", () => {
  mock.timers.enable({ apis: ["Date"] });
  setCachedHash(NETWORK, contract(0), HASH);
  assert.equal(getCachedHash(NETWORK, contract(0)), HASH);

  // Still inside the window.
  mock.timers.tick(59 * 60 * 1000);
  assert.equal(getCachedHash(NETWORK, contract(0)), HASH, "entry is fresh just before the TTL");

  // Past the hour the entry is a miss and is dropped from storage.
  mock.timers.tick(2 * 60 * 1000);
  assert.equal(getCachedHash(NETWORK, contract(0)), null, "entry is gone after the TTL");
});

test("keeps at most 50 entries, evicting the least-recently used", () => {
  for (let index = 0; index < 50; index++) {
    setCachedHash(NETWORK, contract(index), `${index}`);
  }

  // Touch the oldest entry so it becomes the most-recently used one.
  assert.equal(getCachedHash(NETWORK, contract(0)), "0");

  // Five more inserts push out the five oldest untouched entries (1..5), not
  // the one we just read (0).
  for (let index = 50; index < 55; index++) {
    setCachedHash(NETWORK, contract(index), `${index}`);
  }

  assert.equal(getCachedHash(NETWORK, contract(0)), "0", "recently-used entry survives");
  assert.equal(getCachedHash(NETWORK, contract(1)), null);
  assert.equal(getCachedHash(NETWORK, contract(5)), null);
  assert.equal(getCachedHash(NETWORK, contract(6)), "6");
  assert.equal(getCachedHash(NETWORK, contract(54)), "54");
});

test("invalidateCachedHash removes a single entry without touching its neighbours", () => {
  setCachedHash(NETWORK, contract(0), HASH);
  setCachedHash(NETWORK, contract(1), HASH);

  invalidateCachedHash(NETWORK, contract(0));

  assert.equal(getCachedHash(NETWORK, contract(0)), null);
  assert.equal(getCachedHash(NETWORK, contract(1)), HASH);
});
