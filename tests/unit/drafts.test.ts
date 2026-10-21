/**
 * Draft persistence helpers (issue #20): the zero-secrets audit, round-trip,
 * expiry, and namespace isolation.
 *
 * The keys audit is the point of this file: `POLICY_DRAFT_FIELDS` and
 * `DEPLOY_DRAFT_FIELDS` are closed lists, and the raw stored JSON is checked
 * against them exactly — the same discipline as `setupChecklist.ts`'s
 * `SETUP_STORED_KEYS` — so a future edit that starts persisting a
 * secret-adjacent field fails here rather than shipping.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DRAFT_TTL_DAYS,
  DRAFT_TTL_MS,
  DEPLOY_DRAFT_BASE,
  DEPLOY_DRAFT_FIELDS,
  DEPLOY_DRAFT_SLOT,
  POLICY_DRAFT_BASE,
  POLICY_DRAFT_FIELDS,
  clearDeployDraft,
  clearPolicyDraft,
  loadDeployDraft,
  loadPolicyDraft,
  saveDeployDraft,
  savePolicyDraft,
  sanitizeDeployDraft,
  sanitizePolicyDraft,
  type DeployDraft,
} from "../../lib/guard/drafts.ts";
import { EMPTY_DRAFT, type PolicyDraft } from "../../lib/guard/policyForm.ts";
import { scopedStorageKey } from "../../lib/guard/guardScoped.ts";
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

/** A policy draft with every field filled, so emptiness can never hide a leak. */
function fullPolicyDraft(): PolicyDraft {
  return {
    perTxCap: "1000",
    windowCap: "5000",
    windowSecs: "86400",
    assets: "CASSETCONTRACT",
    assetCaps: [{ assetContractAddress: "CASSET", maxCapStroops: "100", symbol: "USDC" }],
    recipients: "GRECIPIENT",
    allowAnyRecipient: false,
    protocols: "CProtocol",
    activeFrom: "1735689600",
    activeUntil: "1767225600",
    paused: false,
    dmsGraceSecs: "3600",
  };
}

/** A deploy draft with every field filled, so emptiness can never hide a leak. */
function fullDeployDraft(): DeployDraft {
  return {
    saltHex: "a".repeat(64),
    saltEncoding: "hex",
    saltText: "0x" + "a".repeat(64),
    agentPubkeyHex: "b".repeat(64),
    agentAddress: "GBUQEXAMPLEAGENTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    dmsDurationSecs: "3600",
    perTxCap: "1000",
    windowCap: "5000",
  };
}

function policyKey(network: string, guard: string): string {
  return scopedStorageKey(POLICY_DRAFT_BASE, network, guard);
}

function deployKey(network: string): string {
  return scopedStorageKey(DEPLOY_DRAFT_BASE, network, DEPLOY_DRAFT_SLOT);
}

/** One fixed clock, so a save and a later load in the same test agree on age. */
const CLOCK = () => 1_000_000;

/**
 * Audit the raw stored JSON: the envelope carries exactly `v`/`savedAt`/`draft`,
 * and the draft carries exactly its allowlist — nothing more, in any nesting
 * level reachable from the top two layers. This is the zero-secrets guarantee
 * made executable.
 */
function assertKeysMatchAllowlist(
  stored: string,
  allowlist: readonly string[],
  draftName: string,
): void {
  const parsed = JSON.parse(stored) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["draft", "savedAt", "v"],
    `${draftName} envelope keys must be exactly v/savedAt/draft`,
  );
  assert.equal(parsed.v, 1, `${draftName} envelope version must be 1`);
  const draft = parsed.draft as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(draft).sort(),
    [...allowlist].sort(),
    `${draftName} draft keys must exactly equal its allowlist`,
  );
  // The nested assetCaps rows are three strings each — no extra baggage.
  if (Array.isArray(draft.assetCaps)) {
    for (const row of draft.assetCaps as unknown[]) {
      if (typeof row !== "object" || row === null) continue;
      assert.deepEqual(
        Object.keys(row as Record<string, unknown>).sort(),
        ["assetContractAddress", "maxCapStroops", "symbol"],
        "assetCaps rows carry exactly three public fields",
      );
    }
  }
}

describe("zero-secrets audit", () => {
  it("stores a policy draft whose raw keys equal POLICY_DRAFT_FIELDS exactly", () => {
    const storage = memoryStorage();
    savePolicyDraft("testnet", GUARD_A, fullPolicyDraft(), { storage, now: () => 1_000 });
    const key = policyKey("testnet", GUARD_A);
    const stored = storage.getItem(key);
    assert.ok(stored, "the draft must be persisted");
    assertKeysMatchAllowlist(stored, POLICY_DRAFT_FIELDS, "policyDraft");
  });

  it("stores a deploy draft whose raw keys equal DEPLOY_DRAFT_FIELDS exactly", () => {
    const storage = memoryStorage();
    saveDeployDraft("testnet", fullDeployDraft(), { storage, now: () => 1_000 });
    const key = deployKey("testnet");
    const stored = storage.getItem(key);
    assert.ok(stored, "the draft must be persisted");
    assertKeysMatchAllowlist(stored, DEPLOY_DRAFT_FIELDS, "deployDraft");
  });

  it("sanitizers drop unknown keys, so a secret-adjacent field cannot round-trip", () => {
    const smuggled = {
      ...fullPolicyDraft(),
      secretKey: "SUPERSECRET",
      seedPhrase: "alpha beta gamma",
      xdr: "AAAA...",
    };
    const sanitized = sanitizePolicyDraft(smuggled);
    assert.ok(sanitized);
    assert.ok(
      !("secretKey" in sanitized) && !("seedPhrase" in sanitized) && !("xdr" in sanitized),
      "unknown keys must be dropped at the read edge, not copied",
    );

    const smuggledDeploy = { ...fullDeployDraft(), secretKey: "SUPERSECRET" };
    const sanitizedDeploy = sanitizeDeployDraft(smuggledDeploy);
    assert.ok(sanitizedDeploy);
    assert.ok(!("secretKey" in sanitizedDeploy));
  });
});

describe("round-trip", () => {
  it("restores a policy draft with its fields and savedAt intact", () => {
    const storage = memoryStorage();
    const draft = fullPolicyDraft();
    savePolicyDraft("testnet", GUARD_A, draft, { storage, now: CLOCK });
    const restored = loadPolicyDraft("testnet", GUARD_A, { storage, now: CLOCK });
    assert.ok(restored);
    assert.deepEqual(restored.draft, draft);
    assert.equal(restored.savedAt, CLOCK());
  });

  it("restores a deploy draft with its fields and savedAt intact", () => {
    const storage = memoryStorage();
    const draft = fullDeployDraft();
    saveDeployDraft("testnet", draft, { storage, now: CLOCK });
    const restored = loadDeployDraft("testnet", { storage, now: CLOCK });
    assert.ok(restored);
    assert.deepEqual(restored.draft, draft);
    assert.equal(restored.savedAt, CLOCK());
  });

  it("clear is idempotent and removes only its own key", () => {
    const storage = memoryStorage();
    savePolicyDraft("testnet", GUARD_A, fullPolicyDraft(), { storage, now: CLOCK });
    saveDeployDraft("testnet", fullDeployDraft(), { storage, now: CLOCK });
    clearPolicyDraft("testnet", GUARD_A, { storage });
    assert.equal(loadPolicyDraft("testnet", GUARD_A, { storage, now: CLOCK }), null);
    // The deploy draft lives under a different base and survives the policy clear.
    assert.ok(loadDeployDraft("testnet", { storage, now: CLOCK }));
    clearDeployDraft("testnet", { storage });
    assert.equal(loadDeployDraft("testnet", { storage, now: CLOCK }), null);
    assert.doesNotThrow(() => clearDeployDraft("testnet", { storage }));
  });
});

describe("expiry", () => {
  it("restores a draft just inside the TTL and purges one just outside it", () => {
    const storage = memoryStorage();
    const savedAt = 1_000_000;
    savePolicyDraft("testnet", GUARD_A, fullPolicyDraft(), { storage, now: () => savedAt });

    // Exactly the TTL old is still inside (`>` is the boundary).
    const inside = loadPolicyDraft("testnet", GUARD_A, {
      storage,
      now: () => savedAt + DRAFT_TTL_MS,
    });
    assert.ok(inside, "a draft exactly TTL-old still restores");

    // One millisecond past: ignored, and the storage entry is purged.
    const outside = loadPolicyDraft("testnet", GUARD_A, {
      storage,
      now: () => savedAt + DRAFT_TTL_MS + 1,
    });
    assert.equal(outside, null, "an expired draft does not restore");
    assert.equal(
      storage.getItem(policyKey("testnet", GUARD_A)),
      null,
      "an expired draft is purged, not merely ignored",
    );
  });

  it("publishes a seven-day TTL — long enough for a weekend, short enough to expire", () => {
    assert.equal(DRAFT_TTL_DAYS, 7);
    assert.equal(DRAFT_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it("applies the same expiry to deploy drafts", () => {
    const storage = memoryStorage();
    const savedAt = 5_000;
    saveDeployDraft("testnet", fullDeployDraft(), { storage, now: () => savedAt });
    assert.equal(
      loadDeployDraft("testnet", { storage, now: () => savedAt + DRAFT_TTL_MS + 1 }),
      null,
    );
    assert.equal(storage.getItem(deployKey("testnet")), null, "expired deploy drafts purge too");
  });
});

describe("namespace isolation", () => {
  it("keeps same-guard, different-network entries apart", () => {
    const storage = memoryStorage();
    const testnetDraft = fullPolicyDraft();
    const mainnetDraft = { ...fullPolicyDraft(), perTxCap: "9999" };
    savePolicyDraft("testnet", GUARD_A, testnetDraft, { storage, now: CLOCK });
    savePolicyDraft("mainnet", GUARD_A, mainnetDraft, { storage, now: CLOCK });
    assert.deepEqual(
      loadPolicyDraft("testnet", GUARD_A, { storage, now: CLOCK })?.draft,
      testnetDraft,
    );
    assert.deepEqual(
      loadPolicyDraft("mainnet", GUARD_A, { storage, now: CLOCK })?.draft,
      mainnetDraft,
    );
  });

  it("keeps same-network, different-guard entries apart", () => {
    const storage = memoryStorage();
    const draftA = fullPolicyDraft();
    const draftB = { ...fullPolicyDraft(), perTxCap: "7777" };
    savePolicyDraft("testnet", GUARD_A, draftA, { storage, now: CLOCK });
    savePolicyDraft("testnet", GUARD_B, draftB, { storage, now: CLOCK });
    assert.deepEqual(loadPolicyDraft("testnet", GUARD_A, { storage, now: CLOCK })?.draft, draftA);
    assert.deepEqual(loadPolicyDraft("testnet", GUARD_B, { storage, now: CLOCK })?.draft, draftB);
  });

  it("keeps deploy drafts apart per network, under the reserved (new) slot", () => {
    const storage = memoryStorage();
    const testnetDeploy = fullDeployDraft();
    const mainnetDeploy = { ...fullDeployDraft(), dmsDurationSecs: "7200" };
    saveDeployDraft("testnet", testnetDeploy, { storage, now: CLOCK });
    saveDeployDraft("mainnet", mainnetDeploy, { storage, now: CLOCK });
    assert.deepEqual(loadDeployDraft("testnet", { storage, now: CLOCK })?.draft, testnetDeploy);
    assert.deepEqual(loadDeployDraft("mainnet", { storage, now: CLOCK })?.draft, mainnetDeploy);
  });
});

describe("corruption and inertness", () => {
  it("returns null for unparseable JSON rather than throwing", () => {
    // The corruption-tolerant read lives one layer down (guardScoped swallows
    // the JSON error), so an unparseable payload reads as "no draft" — it may
    // linger as an inert key, but a later valid save overwrites the same slot.
    const storage = memoryStorage({ [policyKey("testnet", GUARD_A)]: "{nope" });
    assert.equal(loadPolicyDraft("testnet", GUARD_A, { storage }), null);
    savePolicyDraft("testnet", GUARD_A, fullPolicyDraft(), { storage, now: CLOCK });
    assert.ok(
      loadPolicyDraft("testnet", GUARD_A, { storage, now: CLOCK }),
      "a valid save overwrites the corrupt slot",
    );
  });

  it("discards a draft that does not sanitize, and purges it", () => {
    const storage = memoryStorage({
      [policyKey("testnet", GUARD_A)]: JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        draft: "not an object",
      }),
    });
    assert.equal(loadPolicyDraft("testnet", GUARD_A, { storage }), null);
    assert.equal(storage.getItem(policyKey("testnet", GUARD_A)), null);
  });

  it("discards an envelope with a missing or non-finite savedAt", () => {
    const storage = memoryStorage({
      [policyKey("testnet", GUARD_A)]: JSON.stringify({ v: 1, draft: fullPolicyDraft() }),
    });
    assert.equal(loadPolicyDraft("testnet", GUARD_A, { storage }), null);
    assert.equal(storage.getItem(policyKey("testnet", GUARD_A)), null, "purged, not ignored");
  });

  it("is inert without storage — SSR and tests must never throw", () => {
    const options = { storage: null as StorageLike | null };
    assert.doesNotThrow(() => savePolicyDraft("testnet", GUARD_A, EMPTY_DRAFT, options));
    assert.equal(loadPolicyDraft("testnet", GUARD_A, options), null);
    assert.doesNotThrow(() => clearPolicyDraft("testnet", GUARD_A, options));
    assert.doesNotThrow(() => saveDeployDraft("testnet", fullDeployDraft(), options));
    assert.equal(loadDeployDraft("testnet", options), null);
    assert.doesNotThrow(() => clearDeployDraft("testnet", options));
  });
});
