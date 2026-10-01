import assert from "node:assert/strict";
import { test } from "node:test";
import { Address, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { describeAuthorization, simulateFreeze } from "../../lib/guard/guardOps.ts";
import { calculateFeeHeadroom } from "../../lib/guard/feeEstimator.ts";
import { INCLUSION_FEE } from "../../lib/guard/submit.ts";

const SOURCE = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/**
 * A server stand-in that records what the dry run asks of it. `sendTransaction`
 * throws, so any code path that tries to broadcast fails the test loudly rather
 * than silently passing a simulation off as a write.
 */
class FakeServer {
  simulateCalls = 0;
  sendCalls = 0;
  getAccountCalls = 0;

  constructor(
    private readonly response: unknown,
    private readonly failGetAccount = false,
  ) {}

  async getAccount(): Promise<{ sequenceNumber: () => string }> {
    this.getAccountCalls += 1;
    if (this.failGetAccount) throw new Error("account not found");
    return { sequenceNumber: () => "12345" };
  }

  async simulateTransaction(): Promise<unknown> {
    this.simulateCalls += 1;
    return this.response;
  }

  async sendTransaction(): Promise<never> {
    this.sendCalls += 1;
    throw new Error("dry run must never broadcast");
  }
}

/**
 * A signer that counts (and refuses) every signature request. If the dry-run
 * path ever reaches the wallet, these counters are non-zero and the assertion
 * catches it — which is the whole acceptance criterion.
 */
function recordingSigner() {
  const calls = { signTransaction: 0, signAuthEntry: 0 };
  return {
    calls,
    signer: {
      address: SOURCE,
      async signTransaction(): Promise<string> {
        calls.signTransaction += 1;
        throw new Error("dry run must not sign an envelope");
      },
      async signAuthEntry(): Promise<string> {
        calls.signAuthEntry += 1;
        throw new Error("dry run must not sign an auth entry");
      },
    },
  };
}

function rootInvocation(): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(GUARD).toScAddress(),
        functionName: "freeze",
        args: [],
      }),
    ),
    subInvocations: [],
  });
}

function sourceAccountAuth(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: rootInvocation(),
  });
}

function addressAuth(address: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString("0"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: rootInvocation(),
  });
}

function successResponse(auth: xdr.SorobanAuthorizationEntry[] = []) {
  return {
    transactionData: new SorobanDataBuilder().build(),
    minResourceFee: "100",
    latestLedger: 4242,
    result: { auth, retval: xdr.ScVal.scvVoid() },
  };
}

test("a freeze dry run reports resources and refuses to sign or broadcast", async () => {
  const server = new FakeServer(successResponse());
  const { signer, calls } = recordingSigner();

  const result = await simulateFreeze({
    server: server as unknown as rpc.Server,
    signer,
    guard: GUARD,
  });

  assert.equal(result.kind, "simulated");
  assert.equal(result.dryRun, true);
  if (result.kind !== "simulated") return;

  // Fees: the preflight resource fee is reported unbuffered, but the fee the
  // envelope actually carries is the inclusion floor plus that resource fee
  // after the Standard-preset headroom the SDK applies (15%), so the total is
  // higher than resourceFee + inclusionFee.
  assert.equal(result.resourceFeeStroops, "100");
  assert.equal(result.inclusionFeeStroops, INCLUSION_FEE);
  const paddedResourceFee = calculateFeeHeadroom(0, BigInt(result.resourceFeeStroops)).fee;
  assert.equal(result.totalFeeStroops, (BigInt(INCLUSION_FEE) + paddedResourceFee).toString());
  assert.equal(result.latestLedger, 4242);
  assert.ok(result.footprintEntries >= 0);

  // The whole point: no wallet request, no broadcast.
  assert.equal(calls.signTransaction, 0, "dry run must not sign the envelope");
  assert.equal(calls.signAuthEntry, 0, "dry run must not sign an auth entry");
  assert.equal(server.sendCalls, 0, "dry run must not broadcast");
  assert.equal(server.simulateCalls, 1, "dry run runs exactly one simulation");
});

test("the dry run names the authorizations the freeze would require", async () => {
  const server = new FakeServer(successResponse([sourceAccountAuth(), addressAuth(SOURCE)]));
  const { signer, calls } = recordingSigner();

  const result = await simulateFreeze({
    server: server as unknown as rpc.Server,
    signer,
    guard: GUARD,
  });

  assert.equal(result.kind, "simulated");
  if (result.kind !== "simulated") return;

  assert.deepEqual(result.authorizations, [
    { kind: "source_account", address: null },
    { kind: "address", address: SOURCE },
  ]);
  assert.equal(result.separateSignaturesRequired, 1);
  assert.equal(calls.signAuthEntry, 0);
  assert.equal(server.sendCalls, 0);
});

test("a source-account-only authorization needs no separate signatures", async () => {
  const server = new FakeServer(successResponse([sourceAccountAuth()]));
  const { signer } = recordingSigner();

  const result = await simulateFreeze({
    server: server as unknown as rpc.Server,
    signer,
    guard: GUARD,
  });

  assert.equal(result.kind, "simulated");
  if (result.kind !== "simulated") return;
  assert.equal(result.separateSignaturesRequired, 0);
  assert.deepEqual(result.authorizations, [{ kind: "source_account", address: null }]);
});

test("a refused simulation is reported as refused, still without signing", async () => {
  const server = new FakeServer({
    error: "HostError: Error(Contract, #4)",
    events: [{ kind: "diagnostic" }],
  });
  const { signer, calls } = recordingSigner();

  const result = await simulateFreeze({
    server: server as unknown as rpc.Server,
    signer,
    guard: GUARD,
  });

  assert.equal(result.kind, "refused");
  assert.equal(result.dryRun, true);
  if (result.kind !== "refused") return;
  assert.match(result.detail, /HostError/);
  assert.equal(result.diagnosticEvents.length, 1);
  assert.equal(calls.signTransaction, 0);
  assert.equal(calls.signAuthEntry, 0);
  assert.equal(server.sendCalls, 0);
});

test("an unreachable account is a refused dry run, not a throw", async () => {
  const server = new FakeServer(successResponse(), true);
  const { signer, calls } = recordingSigner();

  const result = await simulateFreeze({
    server: server as unknown as rpc.Server,
    signer,
    guard: GUARD,
  });

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.match(result.detail, /could not load account/);
  assert.equal(server.simulateCalls, 0);
  assert.equal(calls.signTransaction, 0);
  assert.equal(calls.signAuthEntry, 0);
});

test("describeAuthorization reads V2 address credentials too", () => {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(SOURCE).toScAddress(),
        nonce: xdr.Int64.fromString("0"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: rootInvocation(),
  });
  assert.deepEqual(describeAuthorization(entry), { kind: "address", address: SOURCE });
});
