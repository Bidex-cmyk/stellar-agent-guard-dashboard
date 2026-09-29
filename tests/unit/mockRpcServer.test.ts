/**
 * The mock Soroban RPC server speaks the real wire protocol (issue #111).
 *
 * These tests check the mock at two levels: the raw JSON-RPC 2.0 envelopes it
 * puts on the wire, and — the stronger check — that the SDK's own `rpc.Server`
 * parses every response without complaint. If the mock drifted from the
 * stellar-rpc response shapes, the SDK's XDR decoders would throw here.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { JSON_RPC_ERRORS, MockSorobanRpc } from "../mocks/mockRpcServer.ts";
import {
  MOCK_GENESIS_LEDGER,
  MOCK_GUARD,
  MOCK_PASSPHRASE,
  MOCK_PROTOCOL_VERSION,
  authError,
  contractCodeEntry,
  contractInstanceEntry,
  contractTrap,
  eventId,
  guardEvent,
  ledgerCloseTime,
  simSuccess,
} from "../mocks/sorobanFixtures.ts";

const SOURCE = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));

function invocation(fn: string, args: xdr.ScVal[] = [], sequence = "0") {
  return new TransactionBuilder(new Account(SOURCE.publicKey(), sequence), {
    fee: "100",
    networkPassphrase: MOCK_PASSPHRASE,
  })
    .addOperation(Operation.invokeContractFunction({ contract: MOCK_GUARD, function: fn, args }))
    .setTimeout(30)
    .build();
}

async function post(mock: MockSorobanRpc, body: unknown) {
  const response = await fetch(mock.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, text };
}

describe("MockSorobanRpc — JSON-RPC 2.0 envelope", () => {
  let mock: MockSorobanRpc;
  before(async () => {
    mock = await MockSorobanRpc.start();
  });
  after(() => mock.stop());

  test("echoes the request id and version on success", async () => {
    const { status, json } = await post(mock, { jsonrpc: "2.0", id: "abc-1", method: "getHealth" });
    assert.equal(status, 200);
    assert.equal(json.jsonrpc, "2.0");
    assert.equal(json.id, "abc-1");
    assert.equal(json.result.status, "healthy");
    assert.equal("error" in json, false);
  });

  test("malformed JSON is a -32700 parse error with a null id", async () => {
    const { json } = await post(mock, "{not json");
    assert.deepEqual(json, { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERRORS.parseError, message: "parse error" } });
  });

  test("a request without jsonrpc/method is -32600 invalid request", async () => {
    const { json } = await post(mock, { id: 4, method: "getHealth" });
    assert.equal(json.id, 4);
    assert.equal(json.error.code, JSON_RPC_ERRORS.invalidRequest);
  });

  test("an unknown method is -32601 method not found", async () => {
    const { json } = await post(mock, { jsonrpc: "2.0", id: 2, method: "getSomethingElse" });
    assert.equal(json.error.code, JSON_RPC_ERRORS.methodNotFound);
  });

  test("batches are answered in order", async () => {
    const { json } = await post(mock, [
      { jsonrpc: "2.0", id: 1, method: "getHealth" },
      { jsonrpc: "2.0", id: 2, method: "getNetwork" },
    ]);
    assert.deepEqual(json.map((reply: { id: number }) => reply.id), [1, 2]);
    assert.equal(json[1].result.passphrase, MOCK_PASSPHRASE);
  });

  test("notifications (no id) get no response body", async () => {
    const { status, text } = await post(mock, { jsonrpc: "2.0", method: "getHealth" });
    assert.equal(status, 204);
    assert.equal(text, "");
  });

  test("only POST is accepted", async () => {
    const response = await fetch(mock.url);
    assert.equal(response.status, 405);
  });

  test("every request is recorded for assertions", async () => {
    const before = mock.callCount("getNetwork");
    await mock.client().getNetwork();
    assert.equal(mock.callCount("getNetwork"), before + 1);
  });
});

describe("MockSorobanRpc — getLatestLedger and ledger progression", () => {
  let mock: MockSorobanRpc;
  let server: rpc.Server;
  beforeEach(async () => {
    mock = await MockSorobanRpc.start();
    server = mock.client();
  });
  afterEach(() => mock.stop());

  test("the SDK decodes the header and close meta", async () => {
    const latest = await server.getLatestLedger();
    assert.equal(latest.sequence, MOCK_GENESIS_LEDGER);
    assert.equal(latest.protocolVersion, MOCK_PROTOCOL_VERSION);
    assert.match(latest.id, /^[0-9a-f]{64}$/);
    assert.equal(latest.headerXdr.ledgerSeq, MOCK_GENESIS_LEDGER);
    assert.equal(latest.closeTime, String(ledgerCloseTime(MOCK_GENESIS_LEDGER)));
  });

  test("closeLedger / advanceLedgers move the head and the close time", async () => {
    const first = await server.getLatestLedger();
    assert.equal(mock.closeLedger(), MOCK_GENESIS_LEDGER + 1);
    assert.equal(mock.advanceLedgers(4), MOCK_GENESIS_LEDGER + 5);
    const later = await server.getLatestLedger();
    assert.equal(later.sequence, MOCK_GENESIS_LEDGER + 5);
    assert.equal(Number(later.closeTime) - Number(first.closeTime), 25);
    assert.notEqual(later.id, first.id);
  });

  test("identical state produces identical ledger hashes (deterministic)", async () => {
    const other = await MockSorobanRpc.start();
    try {
      const [a, b] = await Promise.all([server.getLatestLedger(), other.client().getLatestLedger()]);
      assert.equal(a.id, b.id);
    } finally {
      await other.stop();
    }
  });
});

describe("MockSorobanRpc — getLedgerEntries", () => {
  let mock: MockSorobanRpc;
  before(async () => {
    mock = await MockSorobanRpc.start();
  });
  after(() => mock.stop());

  test("returns stored entries with key, xdr and TTL; omits missing keys", async () => {
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const code = contractCodeEntry(wasm);
    const instance = contractInstanceEntry({ contractId: MOCK_GUARD, wasmHash: code.hash });
    mock.setLedgerEntry(code);
    mock.setLedgerEntry(instance);

    const missing = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: new Uint8Array(32) }));
    const response = await mock.client().getLedgerEntries(instance.key, missing, code.key);
    assert.equal(response.latestLedger, MOCK_GENESIS_LEDGER);
    assert.equal(response.entries.length, 2);
    assert.equal(response.entries[0]!.val.type, "contractData");
    assert.equal(response.entries[1]!.val.type, "contractCode");
    assert.equal(response.entries[0]!.lastModifiedLedgerSeq, MOCK_GENESIS_LEDGER);
    assert.ok((response.entries[0]!.liveUntilLedgerSeq ?? 0) > MOCK_GENESIS_LEDGER);
  });

  test("the SDK's own contract helpers resolve instance → WASM through the mock", async () => {
    const wasm = await mock.client().getContractWasmByContractId(MOCK_GUARD);
    assert.deepEqual(Array.from(wasm), [0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  });

  test("an empty key list is -32602 invalid params", async () => {
    const { json } = await post(mock, { jsonrpc: "2.0", id: 1, method: "getLedgerEntries", params: { keys: [] } });
    assert.equal(json.error.code, JSON_RPC_ERRORS.invalidParams);
  });

  test("an undecodable key is -32602 invalid params", async () => {
    const { json } = await post(mock, {
      jsonrpc: "2.0",
      id: 1,
      method: "getLedgerEntries",
      params: { keys: ["not-xdr"] },
    });
    assert.equal(json.error.code, JSON_RPC_ERRORS.invalidParams);
  });
});

describe("MockSorobanRpc — simulateTransaction", () => {
  let mock: MockSorobanRpc;
  let server: rpc.Server;
  before(async () => {
    mock = await MockSorobanRpc.start();
    server = mock.client();
  });
  beforeEach(() => mock.resetScripts());
  after(() => mock.stop());

  test("success: the SDK parses retval, transactionData and fee", async () => {
    mock.onSimulate({ fn: "echo" }, (call) => simSuccess(call.args[0]!));
    const sim = await server.simulateTransaction(invocation("echo", [nativeToScVal(42n, { type: "u64" })]));
    assert.ok(rpc.Api.isSimulationSuccess(sim));
    assert.equal(scValToNative(sim.result!.retval), 42n);
    assert.equal(sim.minResourceFee, "90000");
    assert.equal(sim.latestLedger, MOCK_GENESIS_LEDGER);
    assert.ok(sim.transactionData);
  });

  test("the invocation is decoded from the envelope (contract, function, args, source)", async () => {
    let seen: { contractId: string; fn: string; source: string; argc: number } | null = null;
    mock.onSimulate({}, (call) => {
      seen = { contractId: call.contractId, fn: call.fn, source: call.source, argc: call.args.length };
      return simSuccess();
    });
    await server.simulateTransaction(invocation("status", [xdr.ScVal.scvBool(true), xdr.ScVal.scvVoid()]));
    assert.deepEqual(seen, { contractId: MOCK_GUARD, fn: "status", source: SOURCE.publicKey(), argc: 2 });
  });

  test("contract trap: an error string and a decodable diagnostic error event", async () => {
    mock.onSimulate({ fn: "initialize" }, contractTrap(2));
    const sim = await server.simulateTransaction(invocation("initialize"));
    assert.ok(rpc.Api.isSimulationError(sim));
    assert.match(sim.error, /^HostError: Error\(Contract, #2\)/);
    assert.equal(sim.events.length, 1);
    const topics = sim.events[0]!.event.body.v0.topics;
    assert.equal(scValToNative(topics[0]!), "error");
    assert.equal(topics[1]!.type, "scvError");
  });

  test("auth error: the Error(Auth, InvalidAction) a wrong signer produces", async () => {
    mock.onSimulate({ fn: "transfer" }, authError());
    const sim = await server.simulateTransaction(invocation("transfer"));
    assert.ok(rpc.Api.isSimulationError(sim));
    assert.match(sim.error, /Error\(Auth, InvalidAction\)/);
  });

  test("scripts are consumed by `times` and later registrations win", async () => {
    mock.onSimulate({ fn: "status" }, simSuccess(xdr.ScVal.scvBool(true)));
    mock.onSimulate({ fn: "status" }, contractTrap(9), { times: 1 });
    const first = await server.simulateTransaction(invocation("status"));
    const second = await server.simulateTransaction(invocation("status"));
    assert.ok(rpc.Api.isSimulationError(first));
    assert.ok(rpc.Api.isSimulationSuccess(second));
  });

  test("an unscripted call is a simulation error naming the call, not a silent success", async () => {
    const sim = await server.simulateTransaction(invocation("nobody_scripted_this"));
    assert.ok(rpc.Api.isSimulationError(sim));
    assert.match(sim.error, /nobody_scripted_this/);
  });

  test("an undecodable envelope is -32602 invalid params", async () => {
    const { json } = await post(mock, {
      jsonrpc: "2.0",
      id: 9,
      method: "simulateTransaction",
      params: { transaction: "AAAA" },
    });
    assert.equal(json.error.code, JSON_RPC_ERRORS.invalidParams);
  });
});

describe("MockSorobanRpc — getEvents", () => {
  let mock: MockSorobanRpc;
  let server: rpc.Server;
  const admin = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(3)).publicKey();
  beforeEach(async () => {
    mock = await MockSorobanRpc.start();
    server = mock.client();
  });
  afterEach(() => mock.stop());

  test("returns events in order with SDK-decodable topics and values", async () => {
    const [l1, l2] = mock.streamEvents([
      [guardEvent.initialized(admin)],
      [guardEvent.authChecked("allowed"), guardEvent.heartbeat(1_789_481_712)],
    ]);
    const page = await server.getEvents({
      startLedger: MOCK_GENESIS_LEDGER,
      filters: [{ type: "contract", contractIds: [MOCK_GUARD] }],
    });
    assert.equal(page.events.length, 3);
    assert.deepEqual(page.events.map((event) => event.ledger), [l1, l2, l2]);
    assert.equal(scValToNative(page.events[0]!.topic[0]!), "event_initialized");
    assert.equal(String(page.events[0]!.contractId), MOCK_GUARD);
    assert.deepEqual(scValToNative(page.events[2]!.value), { at: 1_789_481_712n });
    assert.equal(page.events[0]!.id, eventId(l1!, 1, 0, 0));
    assert.match(page.events[0]!.ledgerClosedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(page.latestLedger, l2);
  });

  test("cursor pagination delivers every event exactly once", async () => {
    mock.streamEvents([
      [guardEvent.heartbeat(1), guardEvent.heartbeat(2)],
      [guardEvent.heartbeat(3)],
      [guardEvent.heartbeat(4), guardEvent.heartbeat(5)],
    ]);
    const seen: bigint[] = [];
    let page = await server.getEvents({ startLedger: MOCK_GENESIS_LEDGER, filters: [], limit: 2 });
    for (;;) {
      seen.push(...page.events.map((event) => (scValToNative(event.value) as { at: bigint }).at));
      if (page.events.length === 0) break;
      page = await server.getEvents({ cursor: page.cursor, filters: [], limit: 2 });
    }
    assert.deepEqual(seen, [1n, 2n, 3n, 4n, 5n]);
  });

  test("an exhausted cursor picks up events from ledgers closed later", async () => {
    mock.closeLedger([guardEvent.heartbeat(1)]);
    const first = await server.getEvents({ startLedger: MOCK_GENESIS_LEDGER, filters: [] });
    assert.equal(first.events.length, 1);
    const empty = await server.getEvents({ cursor: first.cursor, filters: [] });
    assert.equal(empty.events.length, 0);
    mock.closeLedger([guardEvent.frozen(admin)]);
    const next = await server.getEvents({ cursor: empty.cursor, filters: [] });
    assert.deepEqual(next.events.map((event) => scValToNative(event.topic[0]!)), ["event_frozen"]);
  });

  test("filters by contract id and by topic, with * and ** wildcards", async () => {
    const other = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
    mock.closeLedger([
      guardEvent.authChecked("allowed"),
      guardEvent.authChecked("blocked", "per_tx_cap_exceeded"),
      guardEvent.heartbeat(1, other),
    ]);
    const sym = (name: string) => xdr.ScVal.scvSymbol(name).toXDR("base64");

    const byContract = await server.getEvents({
      startLedger: MOCK_GENESIS_LEDGER,
      filters: [{ type: "contract", contractIds: [other] }],
    });
    assert.equal(byContract.events.length, 1);

    const blocked = await server.getEvents({
      startLedger: MOCK_GENESIS_LEDGER,
      filters: [{ topics: [[sym("event_auth_checked"), sym("blocked"), "*"]] }],
    });
    assert.deepEqual(blocked.events.map((event) => scValToNative(event.topic[2]!)), ["per_tx_cap_exceeded"]);

    const anyAuth = await server.getEvents({
      startLedger: MOCK_GENESIS_LEDGER,
      filters: [{ topics: [[sym("event_auth_checked"), "**"]] }],
    });
    assert.equal(anyAuth.events.length, 2);
  });

  test("rejects startLedger outside the retention window, as stellar-rpc does", async () => {
    await assert.rejects(server.getEvents({ startLedger: MOCK_GENESIS_LEDGER + 50, filters: [] }), (error: unknown) => {
      const rpcError = error as { code: number; message: string };
      assert.equal(rpcError.code, JSON_RPC_ERRORS.invalidParams);
      assert.match(rpcError.message, /startLedger must be between the oldest ledger/);
      return true;
    });
  });

  test("rejects a request mixing startLedger and cursor", async () => {
    const { json } = await post(mock, {
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: { startLedger: MOCK_GENESIS_LEDGER, pagination: { cursor: eventId(MOCK_GENESIS_LEDGER, 1, 0, 0) } },
    });
    assert.equal(json.error.code, JSON_RPC_ERRORS.invalidParams);
  });
});

describe("MockSorobanRpc — sendTransaction / getTransaction", () => {
  let mock: MockSorobanRpc;
  let server: rpc.Server;
  beforeEach(async () => {
    mock = await MockSorobanRpc.start();
    server = mock.client();
  });
  afterEach(() => mock.stop());

  function signed(sequence = "1") {
    const tx = invocation("freeze", [], sequence);
    tx.sign(SOURCE);
    return tx;
  }

  test("PENDING → NOT_FOUND until the next ledger close → SUCCESS with return value and events", async () => {
    mock.onSend({
      status: "PENDING",
      retval: xdr.ScVal.scvBool(true),
      events: [guardEvent.frozen(SOURCE.publicKey())],
    });
    const tx = signed();
    const sent = await server.sendTransaction(tx);
    assert.equal(sent.status, "PENDING");
    assert.equal(sent.hash, Buffer.from(tx.hash()).toString("hex"));

    const inFlight = await server.getTransaction(sent.hash);
    assert.equal(inFlight.status, rpc.Api.GetTransactionStatus.NOT_FOUND);

    const ledger = mock.closeLedger();
    const done = await server.getTransaction(sent.hash);
    assert.equal(done.status, rpc.Api.GetTransactionStatus.SUCCESS);
    assert.ok(done.status === rpc.Api.GetTransactionStatus.SUCCESS);
    assert.equal(done.ledger, ledger);
    assert.equal(scValToNative(done.returnValue!), true);
    assert.equal(done.resultXdr.result.type, "txSuccess");

    const events = await server.getEvents({ startLedger: ledger, filters: [] });
    assert.equal(events.events[0]!.txHash, sent.hash);
    assert.equal(scValToNative(events.events[0]!.topic[0]!), "event_frozen");
  });

  test("an included-but-failed transaction reports FAILED with a txFailed result", async () => {
    mock.onSend({ status: "PENDING", result: "failed" });
    const sent = await server.sendTransaction(signed());
    mock.closeLedger();
    const done = await server.getTransaction(sent.hash);
    assert.equal(done.status, rpc.Api.GetTransactionStatus.FAILED);
    assert.ok(done.status === rpc.Api.GetTransactionStatus.FAILED);
    assert.equal(done.resultXdr.result.type, "txFailed");
  });

  test("ERROR carries a decodable errorResult", async () => {
    mock.onSend({ status: "ERROR", code: "txBadSeq" });
    const sent = await server.sendTransaction(signed());
    assert.equal(sent.status, "ERROR");
    assert.equal(sent.errorResult?.result.type, "txBadSeq");
  });

  test("TRY_AGAIN_LATER and DUPLICATE are reported as such", async () => {
    mock.onSend({ status: "TRY_AGAIN_LATER" });
    assert.equal((await server.sendTransaction(signed())).status, "TRY_AGAIN_LATER");
    const tx = signed("2");
    assert.equal((await server.sendTransaction(tx)).status, "PENDING");
    assert.equal((await server.sendTransaction(tx)).status, "DUPLICATE");
  });

  test("autoCloseOnPoll lets pollers finish without manual ledger closes", async () => {
    mock.autoCloseOnPoll = true;
    const sent = await server.sendTransaction(signed());
    const polled = await server.pollTransaction(sent.hash, { attempts: 3, sleepStrategy: () => 0 });
    assert.equal(polled.status, rpc.Api.GetTransactionStatus.SUCCESS);
    assert.equal(mock.latestLedger, MOCK_GENESIS_LEDGER + 1);
  });

  test("a malformed hash is -32602 invalid params", async () => {
    const { json } = await post(mock, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: "xyz" } });
    assert.equal(json.error.code, JSON_RPC_ERRORS.invalidParams);
  });
});

describe("MockSorobanRpc — fault injection", () => {
  let mock: MockSorobanRpc;
  let server: rpc.Server;
  before(async () => {
    mock = await MockSorobanRpc.start();
    server = mock.client();
  });
  beforeEach(() => mock.resetScripts());
  after(() => mock.stop());

  test("rateLimit answers HTTP 429 with Retry-After, then recovers", async () => {
    mock.rateLimit({ times: 2, retryAfterSeconds: 3 });
    const raw = await post(mock, { jsonrpc: "2.0", id: 1, method: "getHealth" });
    assert.equal(raw.status, 429);
    assert.equal(raw.headers.get("retry-after"), "3");

    await assert.rejects(server.getLatestLedger(), (error: unknown) => {
      assert.equal((error as { response?: { status?: number } }).response?.status, 429);
      return true;
    });
    const recovered = await server.getLatestLedger();
    assert.equal(recovered.sequence, MOCK_GENESIS_LEDGER);
  });

  test("a method-scoped fault leaves other methods alone", async () => {
    mock.rateLimit({ method: "simulateTransaction" });
    assert.equal((await server.getHealth()).status, "healthy");
    await assert.rejects(server.simulateTransaction(invocation("status")));
  });

  test("a JSON-RPC error fault surfaces as the SDK's thrown RPC error", async () => {
    mock.injectFault({ kind: "rpcError", code: JSON_RPC_ERRORS.internalError, message: "database is locked" });
    await assert.rejects(server.getNetwork(), { code: JSON_RPC_ERRORS.internalError, message: "database is locked" });
  });
});

describe("MockSorobanRpc — interceptFetch", () => {
  test("captures an rpc.Server pointed at the real testnet URL without any network", async () => {
    const mock = new MockSorobanRpc();
    const restore = mock.interceptFetch("https://soroban-testnet.stellar.org");
    try {
      const server = new rpc.Server("https://soroban-testnet.stellar.org");
      const latest = await server.getLatestLedger();
      assert.equal(latest.sequence, MOCK_GENESIS_LEDGER);
      assert.equal(mock.callCount("getLatestLedger"), 1);
    } finally {
      restore();
    }
  });
});
