/**
 * Deterministic Soroban RPC fixtures for the in-memory mock server.
 *
 * Everything here produces the same bytes the real RPC puts on the wire:
 * base64 XDR for ledger headers, ledger entries, diagnostic and contract events,
 * transaction results and metas. The point is that the SDK's own parsers
 * (`@stellar/stellar-sdk`'s `rpc.Server`) decode these without knowing they came
 * from a mock, so a test exercises the same decode path a testnet call would.
 *
 * Nothing in this module touches the network or a clock: every hash is derived
 * from its inputs, so two runs of the same test produce identical payloads.
 */

import { createHash } from "node:crypto";
import { Address, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { NETWORK, PHASE1_ARTIFACT } from "../../lib/guard/network.ts";

export const MOCK_PASSPHRASE = NETWORK.passphrase;
export const MOCK_GUARD = PHASE1_ARTIFACT.guard;
export const MOCK_TOKEN = PHASE1_ARTIFACT.token;

/** Protocol the mock reports; matches the current testnet major. */
export const MOCK_PROTOCOL_VERSION = 23;
/** First ledger the mock reports as `latestLedger`. */
export const MOCK_GENESIS_LEDGER = 1_000;
/** Unix seconds the genesis ledger closed at. Arbitrary but fixed. */
export const MOCK_GENESIS_CLOSE_TIME = 1_789_481_700;
/** Testnet's target close interval. */
export const MOCK_LEDGER_CLOSE_SECONDS = 5;
/** stellar-rpc's default event/transaction retention window (one day of ledgers). */
export const MOCK_RETENTION_LEDGERS = 17_280;

// ---------------------------------------------------------------------------
// Hashing and ids
// ---------------------------------------------------------------------------

export function sha256(bytes: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** A deterministic 32-byte hash, for fixture fields that just need to be a hash. */
export function fixtureHash(label: string): Uint8Array {
  return sha256(`mock-soroban-rpc:${label}`);
}

/**
 * Stellar's "total order id" (SEP-35): ledger in the high 32 bits, transaction
 * application order in the next 20, operation index in the low 12. stellar-rpc
 * builds event ids from it.
 */
export function toid(ledger: number, txIndex: number, opIndex: number): bigint {
  return (BigInt(ledger) << 32n) | (BigInt(txIndex) << 12n) | BigInt(opIndex);
}

/**
 * The event id format stellar-rpc returns and accepts as a cursor:
 * a zero-padded 19-digit TOID, a dash, and a zero-padded 10-digit event index.
 * Fixed widths mean ids compare correctly as plain strings.
 */
export function eventId(ledger: number, txIndex: number, opIndex: number, eventIndex: number): string {
  return `${toid(ledger, txIndex, opIndex).toString().padStart(19, "0")}-${String(eventIndex).padStart(10, "0")}`;
}

export function ledgerCloseTime(sequence: number): number {
  return MOCK_GENESIS_CLOSE_TIME + (sequence - MOCK_GENESIS_LEDGER) * MOCK_LEDGER_CLOSE_SECONDS;
}

// ---------------------------------------------------------------------------
// Ledger headers (getLatestLedger)
// ---------------------------------------------------------------------------

export function ledgerHeader(sequence: number, protocolVersion = MOCK_PROTOCOL_VERSION): xdr.LedgerHeader {
  const previous = fixtureHash(`ledger:${sequence - 1}`);
  return new xdr.LedgerHeader({
    ledgerVersion: protocolVersion,
    previousLedgerHash: previous,
    scpValue: new xdr.StellarValue({
      txSetHash: fixtureHash(`txset:${sequence}`),
      closeTime: BigInt(ledgerCloseTime(sequence)),
      upgrades: [],
      ext: xdr.StellarValueExt.stellarValueBasic(),
    }),
    txSetResultHash: fixtureHash(`txset-result:${sequence}`),
    bucketListHash: fixtureHash(`bucket-list:${sequence}`),
    ledgerSeq: sequence,
    totalCoins: 1_000_000_000_000_000_000n,
    feePool: 0n,
    inflationSeq: 0,
    idPool: 0n,
    baseFee: 100,
    baseReserve: 5_000_000,
    maxTxSetSize: 1_000,
    skipList: [previous, previous, previous, previous],
    ext: xdr.LedgerHeaderExt.v0(),
  });
}

/** The header, its hash (the ledger "id"), and a minimal close meta, all as wire strings. */
export function ledgerWire(sequence: number, protocolVersion = MOCK_PROTOCOL_VERSION) {
  const header = ledgerHeader(sequence, protocolVersion);
  const headerBytes = header.toXDR();
  const hash = sha256(headerBytes);
  const meta = xdr.LedgerCloseMeta.v0(
    new xdr.LedgerCloseMetaV0({
      ledgerHeader: new xdr.LedgerHeaderHistoryEntry({
        hash,
        header,
        ext: xdr.LedgerHeaderHistoryEntryExt.v0(),
      }),
      txSet: new xdr.TransactionSet({ previousLedgerHash: header.previousLedgerHash, txs: [] }),
      txProcessing: [],
      upgradesProcessing: [],
      scpInfo: [],
    }),
  );
  return {
    id: toHex(hash),
    headerXdr: header.toXDR("base64"),
    metadataXdr: meta.toXDR("base64"),
  };
}

// ---------------------------------------------------------------------------
// Ledger entries (getLedgerEntries)
// ---------------------------------------------------------------------------

export interface LedgerEntryFixture {
  key: xdr.LedgerKey;
  data: xdr.LedgerEntryData;
  /** Defaults to the ledger the entry was stored at. */
  lastModifiedLedgerSeq?: number;
  /** Omitted for entries without a TTL (e.g. accounts), as the real RPC does. */
  liveUntilLedgerSeq?: number;
}

function contractDataKey(
  contractId: string,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability,
    }),
  );
}

function contractDataEntry(
  contractId: string,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
  val: xdr.ScVal,
): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(contractId).toScAddress(),
      key,
      durability,
      val,
    }),
  );
}

/** Uploaded WASM bytecode, keyed by the SHA-256 of its bytes (as on the real ledger). */
export function contractCodeEntry(wasm: Uint8Array): LedgerEntryFixture & { hash: Uint8Array } {
  const hash = sha256(wasm);
  return {
    hash,
    key: xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash })),
    data: xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({ ext: xdr.ContractCodeEntryExt.v0(), hash, code: wasm }),
    ),
  };
}

/**
 * A deployed contract's instance entry: which WASM it runs and its instance
 * storage. `storage` is a list of `[key, value]` ScVal pairs.
 */
export function contractInstanceEntry(params: {
  contractId: string;
  wasmHash: Uint8Array;
  storage?: Array<[xdr.ScVal, xdr.ScVal]>;
}): LedgerEntryFixture {
  const storage = (params.storage ?? []).map(([key, val]) => new xdr.ScMapEntry({ key, val }));
  const instanceKey = xdr.ScVal.scvLedgerKeyContractInstance();
  const durability = xdr.ContractDataDurability.persistent;
  return {
    key: contractDataKey(params.contractId, instanceKey, durability),
    data: contractDataEntry(
      params.contractId,
      instanceKey,
      durability,
      xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(params.wasmHash),
          storage: storage.length > 0 ? storage : null,
        }),
      ),
    ),
  };
}

/**
 * One of a contract's persistent storage entries, keyed the way a Soroban
 * `#[contracttype] enum DataKey { Name }` variant is: `Vec[Symbol("Name")]`.
 */
export function persistentDataEntry(contractId: string, dataKeyName: string, val: xdr.ScVal): LedgerEntryFixture {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(dataKeyName)]);
  const durability = xdr.ContractDataDurability.persistent;
  return {
    key: contractDataKey(contractId, key, durability),
    data: contractDataEntry(contractId, key, durability, val),
  };
}

/** Instance-storage marker the guard sets once `initialize` has run. */
export function initializedFlag(value = true): [xdr.ScVal, xdr.ScVal] {
  return [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Initialized")]), xdr.ScVal.scvBool(value)];
}

// ---------------------------------------------------------------------------
// ScVal helpers for guard-shaped return values
// ---------------------------------------------------------------------------

/** A Soroban struct: a map with symbol keys, sorted as the host sorts them. */
export function structScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((name) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val: fields[name]! })),
  );
}

export function u64(value: bigint | number): xdr.ScVal {
  return xdr.ScVal.scvU64(BigInt(value));
}

export function i128(value: bigint | number): xdr.ScVal {
  const big = BigInt(value);
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: big >> 64n, lo: big & 0xffff_ffff_ffff_ffffn }),
  );
}

/** The guard's `status()` return value. */
export function guardStatusScVal(status: {
  admin_frozen: boolean;
  has_policy: boolean;
  heartbeat_expired: boolean;
  last_heartbeat: bigint | number;
  now: bigint | number;
}): xdr.ScVal {
  return structScVal({
    admin_frozen: xdr.ScVal.scvBool(status.admin_frozen),
    has_policy: xdr.ScVal.scvBool(status.has_policy),
    heartbeat_expired: xdr.ScVal.scvBool(status.heartbeat_expired),
    last_heartbeat: u64(status.last_heartbeat),
    now: u64(status.now),
  });
}

/** The guard's internal rolling-window accounting (`DataKey::Window`). */
export function windowScVal(window: { total: bigint; entries: Array<{ ts: bigint; amount: bigint }> }): xdr.ScVal {
  return structScVal({
    entries: xdr.ScVal.scvVec(
      window.entries.map((entry) => structScVal({ amount: i128(entry.amount), ts: u64(entry.ts) })),
    ),
    total: i128(window.total),
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A contract event before it is placed in a ledger. */
export interface EventFixture {
  contractId: string;
  topics: xdr.ScVal[];
  /** Event data. Defaults to an empty map, as `#[contractevent]` structs without data emit. */
  value?: xdr.ScVal;
  /** Defaults to `"contract"`. */
  type?: "contract" | "system";
}

function sym(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

function byAdmin(admin: string): xdr.ScVal {
  return structScVal({ by: new Address(admin).toScVal() });
}

/**
 * The guard's event vocabulary, shaped exactly as the live contract emits it
 * (see `stellar-agent-guard-sdk`'s `events.ts`): `event_`-prefixed topic names,
 * the decision and reason carried in topics, an allowed decision's reason as the
 * empty symbol.
 */
export const guardEvent = {
  authChecked(result: "allowed" | "blocked", reason = "", contractId: string = MOCK_GUARD): EventFixture {
    return {
      contractId,
      topics: [sym("event_auth_checked"), sym(result), sym(result === "allowed" ? "" : reason)],
      value: xdr.ScVal.scvMap([]),
    };
  },
  heartbeat(at: bigint | number, contractId: string = MOCK_GUARD): EventFixture {
    return { contractId, topics: [sym("event_heartbeat")], value: structScVal({ at: u64(at) }) };
  },
  initialized(admin: string, contractId: string = MOCK_GUARD): EventFixture {
    return { contractId, topics: [sym("event_initialized")], value: byAdmin(admin) };
  },
  frozen(admin: string, contractId: string = MOCK_GUARD): EventFixture {
    return { contractId, topics: [sym("event_frozen")], value: byAdmin(admin) };
  },
  unfrozen(admin: string, contractId: string = MOCK_GUARD): EventFixture {
    return { contractId, topics: [sym("event_unfrozen")], value: byAdmin(admin) };
  },
  policySet(admin: string, contractId: string = MOCK_GUARD): EventFixture {
    return { contractId, topics: [sym("event_policy_set")], value: byAdmin(admin) };
  },
  policyRevoked(admin: string, contractId: string = MOCK_GUARD): EventFixture {
    return { contractId, topics: [sym("event_policy_revoked")], value: byAdmin(admin) };
  },
};

export function contractEvent(event: EventFixture): xdr.ContractEvent {
  const scAddress = new Address(event.contractId).toScAddress();
  const contractId = scAddress.type === "scAddressTypeContract" ? scAddress.contractId : null;
  return new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId,
    type: event.type === "system" ? xdr.ContractEventType.system : xdr.ContractEventType.contract,
    body: xdr.ContractEventBody.v0(
      new xdr.ContractEventV0({ topics: event.topics, data: event.value ?? xdr.ScVal.scvMap([]) }),
    ),
  });
}

/** A diagnostic event as `simulateTransaction` returns them (base64). */
export function diagnosticEventXdr(event: EventFixture, inSuccessfulContractCall = false): string {
  return new xdr.DiagnosticEvent({ inSuccessfulContractCall, event: contractEvent(event) }).toXDR("base64");
}

// ---------------------------------------------------------------------------
// Simulation outcomes (simulateTransaction)
// ---------------------------------------------------------------------------

export type SimulationFixture =
  | {
      kind: "success";
      retval: xdr.ScVal;
      auth?: xdr.SorobanAuthorizationEntry[];
      events?: EventFixture[];
      minResourceFee?: string;
    }
  | {
      kind: "error";
      /** The host error string, as stellar-rpc renders it. */
      error: string;
      events?: EventFixture[];
    };

export function simSuccess(
  retval: xdr.ScVal = xdr.ScVal.scvVoid(),
  extra: Omit<Extract<SimulationFixture, { kind: "success" }>, "kind" | "retval"> = {},
): SimulationFixture {
  return { kind: "success", retval, ...extra };
}

function errorEvent(contractId: string, error: xdr.ScError, message: string): EventFixture {
  return {
    contractId,
    topics: [sym("error"), xdr.ScVal.scvError(error)],
    value: xdr.ScVal.scvString(message),
  };
}

/**
 * A contract panicking with `panic_with_error!(env, Error::X)` where `X = code`.
 * stellar-rpc surfaces it as a simulation `error` string beginning
 * `HostError: Error(Contract, #<code>)`, plus the diagnostic event log.
 */
export function contractTrap(code: number, contractId: string = MOCK_GUARD, extraEvents: EventFixture[] = []): SimulationFixture {
  return {
    kind: "error",
    error:
      `HostError: Error(Contract, #${code})\n\nEvent log (newest first):\n` +
      `   0: [Diagnostic Event] contract:${contractId}, topics:[error, Error(Contract, #${code})], ` +
      `data:"escalating error to VM trap from failed host function call: call"`,
    events: [
      ...extraEvents,
      errorEvent(contractId, xdr.ScError.sceContract(code), "escalating error to VM trap from failed host function call: call"),
    ],
  };
}

/**
 * A `require_auth` that no supplied signature satisfies — what an agent sees
 * when its key is not the one the guard expects.
 */
export function authError(contractId: string = MOCK_GUARD): SimulationFixture {
  return {
    kind: "error",
    error:
      "HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n" +
      `   0: [Diagnostic Event] contract:${contractId}, topics:[error, Error(Auth, InvalidAction)], ` +
      `data:"failed account authentication with error"`,
    events: [
      errorEvent(contractId, xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction), "failed account authentication with error"),
    ],
  };
}

/**
 * The guard refusing a call from `__check_auth`: the auth-checked event naming
 * its reason, then the auth failure it escalates to.
 */
export function guardBlocked(reason: string, contractId: string = MOCK_GUARD): SimulationFixture {
  const base = authError(contractId);
  return { ...base, events: [guardEvent.authChecked("blocked", reason, contractId), ...(base.events ?? [])] };
}

export function emptySorobanDataXdr(): string {
  return new SorobanDataBuilder().build().toXDR("base64");
}

// ---------------------------------------------------------------------------
// Transaction outcomes (sendTransaction / getTransaction)
// ---------------------------------------------------------------------------

export type TransactionResultCode = "txBadSeq" | "txInsufficientFee" | "txBadAuth" | "txMalformed" | "txSorobanInvalid";

/** The `errorResultXdr` for a transaction refused at submission. */
export function rejectedResultXdr(code: TransactionResultCode, feeCharged = 100n): string {
  return new xdr.TransactionResult({
    feeCharged,
    result: xdr.TransactionResultResult[code](),
    ext: xdr.TransactionResultExt.v0(),
  }).toXDR("base64");
}

/** `resultXdr` for an included invocation: success carries the return value's hash. */
export function includedResultXdr(success: boolean, retval: xdr.ScVal, feeCharged = 100n): string {
  const op = xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(
      success
        ? xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(sha256(retval.toXDR()))
        : xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
    ),
  );
  return new xdr.TransactionResult({
    feeCharged,
    result: success ? xdr.TransactionResultResult.txSuccess([op]) : xdr.TransactionResultResult.txFailed([op]),
    ext: xdr.TransactionResultExt.v0(),
  }).toXDR("base64");
}

/** A protocol-23 `TransactionMeta` (v4) carrying the return value and contract events. */
export function transactionMetaXdr(retval: xdr.ScVal | null, events: EventFixture[]): string {
  return xdr.TransactionMeta.v4(
    new xdr.TransactionMetaV4({
      ext: xdr.ExtensionPoint.v0(),
      txChangesBefore: [],
      operations: [
        new xdr.OperationMetaV2({ ext: xdr.ExtensionPoint.v0(), changes: [], events: events.map(contractEvent) }),
      ],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMetaV2({ ext: xdr.SorobanTransactionMetaExt.v0(), returnValue: retval }),
      events: [],
      diagnosticEvents: [],
    }),
  ).toXDR("base64");
}
