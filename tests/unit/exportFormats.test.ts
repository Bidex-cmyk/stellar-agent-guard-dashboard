import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Address, Contract, Keypair, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  AUDIT_LOG_SCHEMA,
  auditLogFilename,
  isFilterActive,
  ndjsonLine,
  telemetryToAuditLog,
  toAuditRecord,
  toJsonSafe,
  toNdjson,
} from "../../lib/guard/exportFormats.ts";
import { EMPTY_TELEMETRY_FILTER, type TelemetryFilter } from "../../lib/guard/telemetryExport.ts";
import {
  GuardFeed,
  attachLedgerXdr,
  refusedEventsFromDiagnostics,
  type TelemetryEvent,
} from "../../lib/guard/telemetry.ts";

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const ADMIN = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1)).publicKey();
const TX = "ab".repeat(32);
const U64_MAX = 18_446_744_073_709_551_615n;
const I128_BIG = 170_141_183_460_469_231_731_687_303_715_884_105_727n;

function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    contractId: GUARD,
    ledger: 4_691_628,
    ledgerClosedAt: "2026-09-25T14:03:07Z",
    transactionHash: TX,
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
    ...overrides,
  };
}

const sym = (name: string) => xdr.ScVal.scvSymbol(name);

function lines(ndjson: string): string[] {
  assert.ok(ndjson.endsWith("\n"), "every NDJSON record is newline-terminated");
  return ndjson.slice(0, -1).split("\n");
}

describe("NDJSON formatting", () => {
  test("one valid JSON object per line, each terminated by \\n", () => {
    const out = toNdjson([{ a: 1 }, { b: "two" }, { c: [3] }]);
    assert.equal(out, '{"a":1}\n{"b":"two"}\n{"c":[3]}\n');
    for (const line of lines(out)) assert.equal(typeof JSON.parse(line), "object");
  });

  test("an empty export is an empty file, not a blank line", () => {
    assert.equal(toNdjson([]), "");
  });

  test("newlines, carriage returns, tabs, quotes and backslashes cannot break a line", () => {
    const nasty = 'line1\nline2\r\n\t"quoted" \\ back\u0000nul\u001b[31m';
    const line = ndjsonLine({ reason: nasty });
    assert.equal(line.includes("\n"), false);
    assert.equal(line.includes("\r"), false);
    assert.deepEqual(JSON.parse(line), { reason: nasty });
  });

  test("U+2028 / U+2029 are escaped so line splitters see one record", () => {
    const separators = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const line = ndjsonLine({ text: separators });
    assert.equal(line, '{"text":"a\\u2028b\\u2029c"}');
    assert.equal(line.includes(String.fromCharCode(0x2028)) || line.includes(String.fromCharCode(0x2029)), false);
    assert.equal(JSON.parse(line).text, separators);
  });

  test("non-ASCII text is kept as UTF-8, not mangled", () => {
    const line = ndjsonLine({ label: "Évènement — 監査 🔒" });
    assert.equal(JSON.parse(line).label, "Évènement — 監査 🔒");
  });
});

describe("precision", () => {
  test("bigints become exact decimal strings, including u64::MAX and i128", () => {
    assert.deepEqual(toJsonSafe({ amount: U64_MAX, total: -I128_BIG, nested: [{ at: 1n }] }), {
      amount: "18446744073709551615",
      total: "-170141183460469231731687303715884105727",
      nested: [{ at: "1" }],
    });
  });

  test("unsafe integers and non-finite numbers are stringified instead of rounded", () => {
    assert.equal(toJsonSafe(2 ** 53 + 2), "9007199254740994");
    assert.equal(toJsonSafe(Number.NaN), "NaN");
    assert.equal(toJsonSafe(42), 42);
    assert.equal(toJsonSafe(1.5), 1.5);
  });

  test("bytes are hex, maps are objects, SDK objects use their canonical string", () => {
    assert.deepEqual(toJsonSafe(new Uint8Array([0, 15, 255])), { hex: "000fff" });
    assert.deepEqual(toJsonSafe(new Map([["k", 1n]])), { k: "1" });
    assert.equal(toJsonSafe(new Address(ADMIN)), ADMIN);
    assert.equal(toJsonSafe(new Contract(GUARD)), GUARD);
  });

  test("ledger sequence is a string and a stroop amount survives the round trip", () => {
    const record = toAuditRecord(event({ ledger: 4_294_967_295, data: { amount: U64_MAX } }));
    const parsed = JSON.parse(ndjsonLine(record));
    assert.equal(parsed.ledger, "4294967295");
    assert.equal(BigInt(parsed.data.amount), U64_MAX);
  });
});

describe("audit records", () => {
  test("carry verdict, reason, source, ledger, hash, timestamp and raw XDR", () => {
    const raw = {
      eventId: "0020151093628604416-0000000000",
      topicXdr: [sym("event_auth_checked").toXDR("base64")],
      valueXdr: xdr.ScVal.scvMap([]).toXDR("base64"),
      diagnosticEventXdr: null,
      inSuccessfulContractCall: true,
    };
    const record = toAuditRecord(event({ raw, observedAt: "2026-09-25T14:03:09.000Z" }));
    assert.equal(record.record, "guard_event");
    assert.equal(record.verdict, "allowed");
    assert.equal(record.reason, null);
    assert.equal(record.timestamp, "2026-09-25T14:03:07Z");
    assert.equal(record.timestampSource, "ledger_close");
    assert.equal(record.transactionHash, TX);
    assert.deepEqual(record.raw, raw);
  });

  test("a diagnostic refusal is timestamped by observation and has no ledger or hash", () => {
    const record = toAuditRecord(
      event({
        source: "diagnostic",
        ledger: null,
        ledgerClosedAt: null,
        transactionHash: null,
        decision: { result: "blocked", reason: "admin_frozen", source: "diagnostic" },
        observedAt: "2026-09-25T14:05:00.000Z",
      }),
    );
    assert.equal(record.verdict, "blocked");
    assert.equal(record.reason, "admin_frozen");
    assert.equal(record.ledger, null);
    assert.equal(record.timestamp, "2026-09-25T14:05:00.000Z");
    assert.equal(record.timestampSource, "observed");
    assert.equal(record.raw, null);
  });

  test("the full log is a header line then one line per event", () => {
    const events = [event(), event({ kind: "heartbeat", topic: "event_heartbeat", decision: null, data: { at: 1_789_481_712n } })];
    const out = telemetryToAuditLog({
      events,
      bufferedCount: 2,
      guard: GUARD,
      network: "testnet",
      filter: EMPTY_TELEMETRY_FILTER,
      latestLedger: 4_691_630,
      demo: false,
      exportedAt: new Date("2026-09-25T14:03:07.123Z"),
    });
    const [header, ...rows] = lines(out).map((line) => JSON.parse(line));
    assert.deepEqual(header, {
      record: "audit_header",
      schema: AUDIT_LOG_SCHEMA,
      exportedAt: "2026-09-25T14:03:07.123Z",
      guard: GUARD,
      network: "testnet",
      scope: "full",
      filter: { verdict: "all", topic: "all", contract: "" },
      eventCount: 2,
      bufferedCount: 2,
      latestLedger: "4691630",
      demo: false,
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1].data, { at: "1789481712" });
  });

  test("a filtered export says so in its header", () => {
    const filter: TelemetryFilter = { verdict: "blocked", topic: "all", contract: "" };
    const out = telemetryToAuditLog({
      events: [],
      bufferedCount: 7,
      guard: GUARD,
      network: "testnet",
      filter,
      latestLedger: null,
      demo: true,
    });
    const header = JSON.parse(lines(out)[0]!);
    assert.equal(header.scope, "filtered");
    assert.deepEqual(header.filter, filter);
    assert.equal(header.eventCount, 0);
    assert.equal(header.bufferedCount, 7);
    assert.equal(header.latestLedger, null);
  });
});

describe("filter scope", () => {
  test("only a narrowing filter marks an export as filtered", () => {
    assert.equal(isFilterActive(EMPTY_TELEMETRY_FILTER), false);
    assert.equal(isFilterActive({ ...EMPTY_TELEMETRY_FILTER, contract: "   " }), false);
    assert.equal(isFilterActive({ ...EMPTY_TELEMETRY_FILTER, verdict: "blocked" }), true);
    assert.equal(isFilterActive({ ...EMPTY_TELEMETRY_FILTER, topic: "event_heartbeat" }), true);
    assert.equal(isFilterActive({ ...EMPTY_TELEMETRY_FILTER, contract: "CAYJ" }), true);
  });

  test("the header records the contract search trimmed, as it was applied", () => {
    const out = telemetryToAuditLog({
      events: [],
      bufferedCount: 0,
      guard: GUARD,
      network: "testnet",
      filter: { verdict: "all", topic: "all", contract: "  CAYJ " },
      latestLedger: null,
      demo: false,
    });
    const header = JSON.parse(lines(out)[0]!);
    assert.equal(header.scope, "filtered");
    assert.equal(header.filter.contract, "CAYJ");
  });
});

describe("filename", () => {
  test("is timestamped, filesystem-safe and ends in .ndjson", () => {
    const at = new Date("2026-09-25T14:03:07.123Z");
    assert.equal(auditLogFilename(at), "guard-audit-log-2026-09-25T14-03-07Z.ndjson");
    assert.equal(auditLogFilename(at, "filtered"), "guard-audit-log-filtered-2026-09-25T14-03-07Z.ndjson");
    assert.equal(/[:/\\]/.test(auditLogFilename(at)), false);
  });
});

describe("raw XDR capture", () => {
  function rawEvent(ledger: number, topics: xdr.ScVal[], value: xdr.ScVal, id: string): rpc.Api.EventResponse {
    return {
      id,
      type: "contract",
      ledger,
      ledgerClosedAt: "2026-09-25T14:03:07Z",
      transactionIndex: 1,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      txHash: TX,
      contractId: new Contract(GUARD),
      topic: topics,
      value,
    } as rpc.Api.EventResponse;
  }

  function decoded(ledger: number, topic: string, kind: GuardEvent["kind"]): GuardEvent {
    return {
      kind,
      topic,
      source: "ledger",
      contractId: GUARD,
      ledger,
      ledgerClosedAt: "2026-09-25T14:03:07Z",
      transactionHash: TX,
      decision: null,
      data: {},
    };
  }

  test("pairs decoded ledger events with their raw page, skipping ones the SDK dropped", () => {
    const heartbeatValue = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("at"), val: xdr.ScVal.scvU64(1n) }),
    ]);
    const raw = [
      rawEvent(10, [sym("event_heartbeat")], heartbeatValue, "0000000042949672960-0000000000"),
      rawEvent(10, [sym("not_a_guard_event")], xdr.ScVal.scvVoid(), "0000000042949672960-0000000001"),
      rawEvent(11, [sym("event_frozen")], xdr.ScVal.scvMap([]), "0000000047244640256-0000000000"),
    ];
    const out = attachLedgerXdr(
      [decoded(10, "event_heartbeat", "heartbeat"), decoded(11, "event_frozen", "frozen")],
      raw,
    );
    assert.equal(out[0]!.raw?.eventId, "0000000042949672960-0000000000");
    assert.equal(out[0]!.raw?.valueXdr, heartbeatValue.toXDR("base64"));
    assert.equal(out[1]!.raw?.eventId, "0000000047244640256-0000000000");
    assert.deepEqual(
      out[1]!.raw?.topicXdr.map((topic) => scValToNative(xdr.ScVal.fromXDR(topic, "base64"))),
      ["event_frozen"],
    );
    assert.ok(out[0]!.observedAt);
  });

  test("GuardFeed attaches raw XDR from the getEvents page it polled", async () => {
    const page = [rawEvent(10, [sym("event_heartbeat")], xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("at"), val: xdr.ScVal.scvU64(U64_MAX) }),
    ]), "0000000042949672960-0000000000")];
    const stub = {
      getLatestLedger: async () => ({ sequence: 10 }),
      getEvents: async () => ({ events: page, cursor: "c1", latestLedger: 10 }),
    } as unknown as rpc.Server;
    const feed = new GuardFeed(stub, GUARD);
    const result = await feed.pollOnce();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.raw?.eventId, page[0]!.id);
    // And the decoded u64 is exported exactly.
    assert.deepEqual(toAuditRecord(result.events[0]!).data, { at: U64_MAX.toString() });
  });

  test("refused diagnostics keep the full DiagnosticEvent XDR, from objects or base64", () => {
    const scAddress = new Address(GUARD).toScAddress();
    assert.equal(scAddress.type, "scAddressTypeContract");
    if (scAddress.type !== "scAddressTypeContract") return;
    const contractId = scAddress.contractId;
    const diagnostic = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId,
        type: xdr.ContractEventType.contract,
        body: xdr.ContractEventBody.v0(
          new xdr.ContractEventV0({
            topics: [sym("event_auth_checked"), sym("blocked"), sym("admin_frozen")],
            data: xdr.ScVal.scvMap([]),
          }),
        ),
      }),
    });
    const noise = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId,
        type: xdr.ContractEventType.diagnostic,
        body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [sym("fn_call")], data: xdr.ScVal.scvVoid() })),
      }),
    });

    for (const input of [[noise, diagnostic], [noise.toXDR("base64"), diagnostic.toXDR("base64")]]) {
      const [refused] = refusedEventsFromDiagnostics(input, GUARD);
      assert.ok(refused);
      assert.equal(refused.decision?.reason, "admin_frozen");
      assert.equal(refused.raw?.diagnosticEventXdr, diagnostic.toXDR("base64"));
      assert.equal(refused.raw?.topicXdr.length, 3);
      assert.equal(refused.raw?.inSuccessfulContractCall, false);
      assert.ok(refused.observedAt);
    }
  });
});
