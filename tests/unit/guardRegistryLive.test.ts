/**
 * The add-by-address flow against a real RPC protocol (the in-memory mock).
 *
 * The acceptance criterion is call *counts*, not just outcomes: an invalid
 * address must be rejected with no RPC call at all, a valid-but-unreachable one
 * must be refused without being saved, and the add flow must issue zero
 * `sendTransaction` calls because it signs nothing. A mock whose `status()`
 * fixture is absent therefore proves "unreachable", and the counters prove the
 * wallet was never touched.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { xdr, type rpc } from "@stellar/stellar-sdk";
import { MockSorobanRpc } from "../mocks/mockRpcServer.ts";
import { guardStatusScVal, simSuccess } from "../mocks/sorobanFixtures.ts";
import { addGuard } from "../../lib/guard/registry.ts";
import { loadInstances, type StorageLike } from "../../lib/guard/instance.ts";

// A real StrKey that is deliberately not one of `KNOWN_INSTANCES`: a known
// address is never written to storage, so using one would make the persistence
// assertion vacuous. (The Phase 1 guard's token contract is a valid C… StrKey.)
const LIVE = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
// Regex-shaped but with a bad StrKey checksum: must be rejected as invalid
// without an RPC call.
const BAD_CHECKSUM = `C${"A".repeat(55)}`;
const STORAGE_KEY = "stellar-agent-guard-dashboard.instances.v2.testnet";

function memoryStorage(): StorageLike & { dump(): Record<string, string> } {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    dump: () => Object.fromEntries(data),
  };
}

function liveStatus(adminFrozen = false) {
  return guardStatusScVal({
    admin_frozen: adminFrozen,
    has_policy: true,
    heartbeat_expired: false,
    last_heartbeat: 1n,
    now: 2n,
  });
}

describe("addGuard live verification", () => {
  let mock: MockSorobanRpc;
  let server: rpc.Server;

  // A fresh server per test: the mock records every request, so sharing one
  // would make the call-count assertions cumulative rather than per-flow.
  beforeEach(async () => {
    mock = await MockSorobanRpc.start();
    server = mock.client();
  });
  afterEach(() => mock.stop());

  it("adds a live guard after one status() read, signing nothing", async () => {
    mock.onSimulate({ fn: "status" }, simSuccess(liveStatus()));
    const storage = memoryStorage();

    const result = await addGuard({ server, address: LIVE, label: "Live guard", storage });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.instance.guard, LIVE);
    assert.equal(result.instance.network, "testnet");
    assert.match(result.instance.addedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(mock.callCount("simulateTransaction"), 1, "exactly one status() read");
    assert.equal(mock.callCount("sendTransaction"), 0, "the add flow never signs or broadcasts");
    const saved = loadInstances({ storage }).find((instance) => instance.guard === LIVE);
    assert.ok(saved, "the verified guard is persisted");
    assert.ok(storage.dump()[STORAGE_KEY]);
  });

  it("rejects an invalid StrKey without any RPC call and saves nothing", async () => {
    const storage = memoryStorage();
    const result = await addGuard({ server, address: "not-a-contract", label: "Nope", storage });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "invalid");
    assert.equal(
      mock.callCount("simulateTransaction"),
      0,
      "an invalid string is not put on the wire",
    );
    assert.equal(mock.callCount("sendTransaction"), 0);
    assert.equal(
      loadInstances({ storage }).some((instance) => instance.guard === "not-a-contract"),
      false,
    );
  });

  it("rejects a regex-shaped but bad-checksum StrKey with no RPC call", async () => {
    const storage = memoryStorage();
    const result = await addGuard({ server, address: BAD_CHECKSUM, label: "Typo", storage });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "invalid", "the SDK checksum, not just the C… shape, is enforced");
    assert.equal(mock.callCount("simulateTransaction"), 0);
    assert.equal(mock.callCount("sendTransaction"), 0);
  });

  it("refuses a valid address whose status() traps, and does not save it", async () => {
    // No fixture registered for status(): the mock answers with a simulation
    // error, which is exactly what a contract without a guard would produce.
    const storage = memoryStorage();
    const result = await addGuard({ server, address: LIVE, label: "Dead", storage });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "unreachable");
    assert.equal(mock.callCount("simulateTransaction"), 1, "it did try to read status()");
    assert.equal(mock.callCount("sendTransaction"), 0);
    assert.equal(
      loadInstances({ storage }).some((instance) => instance.guard === LIVE),
      false,
    );
  });

  it("refuses a transport failure rather than trusting an unreachable guard", async () => {
    mock.injectFault({ kind: "rpcError", code: -32603, message: "database is locked" });
    const storage = memoryStorage();
    const result = await addGuard({ server, address: LIVE, label: "Flaky", storage });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "unreachable");
    assert.equal(mock.callCount("sendTransaction"), 0);
    assert.equal(
      loadInstances({ storage }).some((instance) => instance.guard === LIVE),
      false,
    );
  });

  it("refuses a contract that answers but not in the guard's shape", async () => {
    mock.onSimulate({ fn: "status" }, simSuccess(xdr.ScVal.scvBool(true)));
    const storage = memoryStorage();
    const result = await addGuard({ server, address: LIVE, label: "Wrong shape", storage });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "unreachable");
    assert.match(result.error, /guard's shape|has_policy/);
    assert.equal(mock.callCount("sendTransaction"), 0);
  });
});
