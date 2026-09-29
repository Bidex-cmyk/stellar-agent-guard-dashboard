/**
 * `lib/guard/chain.ts` and the telemetry feed, driven offline through the mock
 * Soroban RPC server (issue #111).
 *
 * Each test hands the production functions an ordinary SDK `rpc.Server` bound
 * to the mock, so the code path is the one the dashboard runs against testnet —
 * transaction building, JSON-RPC, XDR decoding — minus the network.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Account, Keypair, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import {
  isInitialized,
  readContract,
  readPolicy,
  readStatus,
  readWindow,
  verifyWasmIdentity,
} from "../../lib/guard/chain.ts";
import { GuardFeed, refusedEventsFromDiagnostics } from "../../lib/guard/telemetry.ts";
import { MockSorobanRpc, type Invocation } from "../mocks/mockRpcServer.ts";
import {
  MOCK_GENESIS_LEDGER,
  MOCK_GUARD,
  authError,
  contractCodeEntry,
  contractInstanceEntry,
  contractTrap,
  guardBlocked,
  guardEvent,
  guardStatusScVal,
  initializedFlag,
  persistentDataEntry,
  simSuccess,
  toHex,
  windowScVal,
} from "../mocks/sorobanFixtures.ts";

const ADMIN = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1)).publicKey();

let mock: MockSorobanRpc;
let server: rpc.Server;

beforeEach(async () => {
  mock = await MockSorobanRpc.start();
  server = mock.client();
});
afterEach(() => mock.stop());

describe("readContract / readStatus / readPolicy", () => {
  test("decodes the guard's status() struct", async () => {
    mock.onSimulate(
      { contractId: MOCK_GUARD, fn: "status" },
      simSuccess(
        guardStatusScVal({
          admin_frozen: true,
          has_policy: true,
          heartbeat_expired: false,
          last_heartbeat: 1_789_481_712,
          now: 1_789_481_732,
        }),
      ),
    );
    const status = await readStatus(server, MOCK_GUARD);
    assert.deepEqual(status, {
      ok: true,
      value: {
        admin_frozen: true,
        has_policy: true,
        heartbeat_expired: false,
        last_heartbeat: 1_789_481_712n,
        now: 1_789_481_732n,
      },
    });
  });

  test("the contract's default-deny state reads back as a null policy", async () => {
    mock.onSimulate({ fn: "policy" }, simSuccess(xdr.ScVal.scvVoid()));
    assert.deepEqual(await readPolicy(server, MOCK_GUARD), { ok: true, value: null });
  });

  test("a contract trap becomes a real error, never a value", async () => {
    mock.onSimulate({ fn: "status" }, contractTrap(4));
    const result = await readStatus(server, MOCK_GUARD);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /Error\(Contract, #4\)/);
  });

  test("an auth error is surfaced verbatim", async () => {
    mock.onSimulate({ fn: "status" }, authError());
    const result = await readStatus(server, MOCK_GUARD);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /Error\(Auth, InvalidAction\)/);
  });

  test("an HTTP 429 from the RPC is reported as a failed read, not thrown", async () => {
    mock.rateLimit({ method: "simulateTransaction" });
    const limited = await readStatus(server, MOCK_GUARD);
    assert.equal(limited.ok, false);
    assert.match(!limited.ok ? limited.error : "", /429/);

    // …and the next poll, once the limiter lets go, succeeds.
    mock.onSimulate({ fn: "status" }, simSuccess(xdr.ScVal.scvBool(true)));
    assert.deepEqual(await readStatus(server, MOCK_GUARD), { ok: true, value: true });
  });

  test("reads are simulated from the fallback source and carry pre-encoded args", async () => {
    let call: Invocation | null = null;
    mock.onSimulate({ fn: "check" }, (invocation) => {
      call = invocation;
      return simSuccess(xdr.ScVal.scvBool(false));
    });
    const arg = xdr.ScVal.scvSymbol("transfer");
    await readContract(server, MOCK_GUARD, "check", [arg]);
    assert.ok(call);
    const seen = call as Invocation;
    assert.equal(seen.args.length, 1);
    assert.equal(seen.args[0]!.toXDR("base64"), arg.toXDR("base64"));
    assert.match(seen.source, /^G[A-Z2-7]{55}$/);
  });
});

describe("ledger reads", () => {
  test("readWindow decodes the guard's persistent Window entry", async () => {
    mock.setLedgerEntry(
      persistentDataEntry(
        MOCK_GUARD,
        "Window",
        windowScVal({ total: 30n, entries: [{ ts: 100n, amount: 10n }, { ts: 200n, amount: 20n }] }),
      ),
    );
    const window = await readWindow(server, MOCK_GUARD);
    assert.deepEqual(window, {
      ok: true,
      value: { total: 30n, entries: [{ amount: 10n, ts: 100n }, { amount: 20n, ts: 200n }] },
    });
  });

  test("readWindow is null before any spend has been recorded", async () => {
    assert.deepEqual(await readWindow(server, MOCK_GUARD), { ok: true, value: null });
  });

  test("isInitialized reads the Initialized flag from instance storage", async () => {
    const code = contractCodeEntry(new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
    mock.setLedgerEntry(contractInstanceEntry({ contractId: MOCK_GUARD, wasmHash: code.hash }));
    assert.equal(await isInitialized(server, MOCK_GUARD), false);

    mock.setLedgerEntry(
      contractInstanceEntry({ contractId: MOCK_GUARD, wasmHash: code.hash, storage: [initializedFlag()] }),
    );
    assert.equal(await isInitialized(server, MOCK_GUARD), true);
  });

  test("verifyWasmIdentity matches when the fetched bytes hash to the declared hash", async () => {
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x2a]);
    const code = contractCodeEntry(wasm);
    mock.setLedgerEntry(code);
    mock.setLedgerEntry(contractInstanceEntry({ contractId: MOCK_GUARD, wasmHash: code.hash }));

    const identity = await verifyWasmIdentity(server, MOCK_GUARD);
    assert.equal(identity.bytes, wasm.length);
    assert.equal(identity.fetchedSha256, toHex(code.hash));
    assert.equal(identity.reportedWasmHash, toHex(code.hash));
    assert.equal(identity.match, true);
  });

  test("verifyWasmIdentity rejects when the contract does not exist", async () => {
    await assert.rejects(verifyWasmIdentity(server, MOCK_GUARD));
  });
});

describe("GuardFeed telemetry over getEvents", () => {
  test("follows a live event stream across ledger closes without duplicates", async () => {
    const feed = new GuardFeed(server, MOCK_GUARD, mock.url);

    // First poll anchors at the head: nothing yet.
    const first = await feed.pollOnce();
    assert.equal(first.events.length, 0);
    assert.equal(first.latestLedger, MOCK_GENESIS_LEDGER);

    mock.streamEvents([
      [guardEvent.initialized(ADMIN), guardEvent.policySet(ADMIN)],
      [guardEvent.authChecked("allowed")],
    ]);
    const second = await feed.pollOnce();
    assert.deepEqual(second.events.map((event) => event.kind), ["initialized", "policy_set", "auth_checked"]);
    assert.equal(second.events[2]!.decision?.result, "allowed");
    assert.equal(second.events[2]!.decision?.reason, null);
    assert.equal(second.events[0]!.source, "ledger");
    assert.equal(second.latestLedger, MOCK_GENESIS_LEDGER + 2);

    // Nothing new → nothing re-delivered.
    assert.equal((await feed.pollOnce()).events.length, 0);

    mock.closeLedger([guardEvent.frozen(ADMIN)]);
    const third = await feed.pollOnce();
    assert.deepEqual(third.events.map((event) => event.kind), ["frozen"]);
  });

  test("only this guard's events are delivered", async () => {
    const otherGuard = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
    const feed = new GuardFeed(server, MOCK_GUARD, mock.url);
    feed.resetFrom(MOCK_GENESIS_LEDGER);
    mock.closeLedger([guardEvent.heartbeat(1, otherGuard), guardEvent.heartbeat(2)]);
    const page = await feed.pollOnce();
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.contractId, MOCK_GUARD);
  });

  test("a rate-limited poll throws and the next poll resumes from the same cursor", async () => {
    const feed = new GuardFeed(server, MOCK_GUARD, mock.url);
    feed.resetFrom(MOCK_GENESIS_LEDGER);
    mock.closeLedger([guardEvent.heartbeat(1)]);
    await feed.pollOnce();
    const cursor = feed.position().cursor;

    mock.closeLedger([guardEvent.heartbeat(2)]);
    mock.rateLimit({ method: "getEvents" });
    await assert.rejects(feed.pollOnce());
    assert.equal(feed.position().cursor, cursor);

    const resumed = await feed.pollOnce();
    assert.deepEqual(resumed.events.map((event) => (event.data as { at: bigint }).at), [2n]);
  });

  test("refused decisions are decoded from simulation diagnostics", async () => {
    mock.onSimulate({ fn: "transfer" }, guardBlocked("admin_frozen"));
    const simulation = await server.simulateTransaction(guardedCall("transfer"));
    assert.ok(rpc.Api.isSimulationError(simulation));
    const refused = refusedEventsFromDiagnostics(simulation.events, MOCK_GUARD);
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0]!.decision, { result: "blocked", reason: "admin_frozen", source: "diagnostic" });
  });
});

/** Any guarded call; the fixture answers by function name. */
function guardedCall(fn: string) {
  return new TransactionBuilder(new Account(ADMIN, "0"), { fee: "100", networkPassphrase: mock.passphrase })
    .addOperation(Operation.invokeContractFunction({ contract: MOCK_GUARD, function: fn, args: [] }))
    .setTimeout(30)
    .build();
}
