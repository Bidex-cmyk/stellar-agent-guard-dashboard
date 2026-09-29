/**
 * A lightweight, in-memory Soroban RPC server for offline tests.
 *
 * Tests that talk to testnet are slow and flaky: latency, rate limits and the
 * periodic testnet reset all show up as red builds that have nothing to do with
 * the change under test. This harness speaks the same JSON-RPC 2.0 wire protocol
 * as stellar-rpc, over real HTTP on a loopback port, so the unmodified
 * `rpc.Server` from `@stellar/stellar-sdk` — and therefore every `lib/guard/*`
 * function that takes one — can be pointed at it without a single stub.
 *
 * Implemented methods:
 *   simulateTransaction, getEvents, getLedgerEntries, getLatestLedger,
 *   sendTransaction, getTransaction, getNetwork, getHealth
 *
 * State is explicit and scripted:
 *   - the ledger only advances when a test calls `closeLedger()` / `advanceLedgers()`;
 *   - simulations answer from fixtures registered with `onSimulate()`;
 *   - submitted transactions are included on the next ledger close;
 *   - faults (HTTP 429, JSON-RPC errors) are queued with `injectFault()`.
 *
 * Nothing reads the wall clock or the network, so every run is deterministic.
 *
 * Usage:
 *
 *   const mock = await MockSorobanRpc.start();
 *   const server = mock.client();              // an rpc.Server bound to the mock
 *   mock.onSimulate({ fn: "status" }, simSuccess(guardStatusScVal({...})));
 *   ...
 *   await mock.stop();
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Address, TransactionBuilder, rpc, xdr, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import {
  MOCK_GENESIS_LEDGER,
  MOCK_PASSPHRASE,
  MOCK_PROTOCOL_VERSION,
  MOCK_RETENTION_LEDGERS,
  contractEvent,
  diagnosticEventXdr,
  emptySorobanDataXdr,
  eventId,
  includedResultXdr,
  ledgerCloseTime,
  ledgerWire,
  rejectedResultXdr,
  sha256,
  toHex,
  transactionMetaXdr,
  type EventFixture,
  type LedgerEntryFixture,
  type SimulationFixture,
  type TransactionResultCode,
} from "./sorobanFixtures.ts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 error codes stellar-rpc uses (the standard reserved range). */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

/** What the transport layer sends back: an HTTP status, headers and a body. */
export interface MockHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Scripting types
// ---------------------------------------------------------------------------

/** Which simulated invocation a fixture answers. Omitted fields match anything. */
export interface InvocationMatcher {
  contractId?: string;
  fn?: string;
}

/** A decoded `invokeContract` host function, handed to fixture callbacks. */
export interface Invocation {
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
  source: string;
}

export type SimulationResponder = SimulationFixture | ((call: Invocation) => SimulationFixture);

export interface ScriptOptions {
  /** How many requests this answers before it is spent. Default: unlimited. */
  times?: number;
}

/** A transport- or protocol-level failure injected in front of the handlers. */
export type Fault =
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "rpcError"; code: number; message: string };

/** How `sendTransaction` answers, and what happens once the transaction is included. */
export type SendOutcome =
  | {
      status: "PENDING";
      /** Whether the included transaction succeeds (default) or fails on chain. */
      result?: "success" | "failed";
      retval?: xdr.ScVal;
      /** Contract events the transaction emits; they also appear in `getEvents`. */
      events?: EventFixture[];
    }
  | { status: "ERROR"; code: TransactionResultCode; events?: EventFixture[] }
  | { status: "TRY_AGAIN_LATER" }
  | { status: "DUPLICATE" };

export interface MockSorobanRpcOptions {
  passphrase?: string;
  protocolVersion?: number;
  /** The ledger the mock starts at. */
  startLedger?: number;
  /** How many ledgers of events/transactions are retained. */
  retentionLedgers?: number;
  /**
   * When true, a `getTransaction` for a still-pending hash closes a ledger
   * first, so code that polls for inclusion completes without the test having
   * to interleave `closeLedger()` calls. Default false.
   */
  autoCloseOnPoll?: boolean;
}

interface StoredEvent {
  id: string;
  ledger: number;
  txIndex: number;
  txHash: string;
  type: "contract" | "system";
  contractId: string;
  topicXdr: string[];
  valueXdr: string;
  inSuccessfulContractCall: boolean;
}

interface StoredTransaction {
  hash: string;
  envelopeXdr: string;
  outcome: Extract<SendOutcome, { status: "PENDING" }>;
  ledger: number | null;
  applicationOrder: number;
}

interface Scripted<T> {
  value: T;
  remaining: number;
}

interface SimulationScript extends Scripted<SimulationResponder> {
  match: InvocationMatcher;
}

interface FaultScript extends Scripted<Fault> {
  method: string | null;
}

/** Every request the mock received, for assertions. */
export interface RecordedRequest {
  method: string;
  params: unknown;
  id: JsonRpcId;
}

const MAX_EVENT_LIMIT = 10_000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_FILTERS = 5;
const MAX_LEDGER_KEYS = 200;

// ---------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------

export class MockSorobanRpc {
  readonly passphrase: string;
  readonly protocolVersion: number;
  readonly retentionLedgers: number;
  readonly genesisLedger: number;
  autoCloseOnPoll: boolean;

  /** Every JSON-RPC request received, in order. */
  readonly requests: RecordedRequest[] = [];

  private latest: number;
  private readonly entries = new Map<string, { xdr: string; lastModifiedLedgerSeq: number; liveUntilLedgerSeq?: number }>();
  private readonly events: StoredEvent[] = [];
  private readonly transactions = new Map<string, StoredTransaction>();
  private pending: StoredTransaction[] = [];
  private simulations: SimulationScript[] = [];
  private sends: Array<Scripted<SendOutcome>> = [];
  private faults: FaultScript[] = [];
  /** Per-ledger count of transactions applied, for TOIDs and application order. */
  private readonly txCounts = new Map<number, number>();

  private http: Server | null = null;
  private baseUrl: string | null = null;

  constructor(options: MockSorobanRpcOptions = {}) {
    this.passphrase = options.passphrase ?? MOCK_PASSPHRASE;
    this.protocolVersion = options.protocolVersion ?? MOCK_PROTOCOL_VERSION;
    this.retentionLedgers = options.retentionLedgers ?? MOCK_RETENTION_LEDGERS;
    this.genesisLedger = options.startLedger ?? MOCK_GENESIS_LEDGER;
    this.latest = this.genesisLedger;
    this.autoCloseOnPoll = options.autoCloseOnPoll ?? false;
  }

  /** Construct and start listening on an ephemeral loopback port. */
  static async start(options: MockSorobanRpcOptions = {}): Promise<MockSorobanRpc> {
    const mock = new MockSorobanRpc(options);
    await mock.listen();
    return mock;
  }

  // ---- lifecycle ----------------------------------------------------------

  async listen(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    const http = createServer((req, res) => {
      void this.serveHttp(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = http.address() as AddressInfo;
    this.http = http;
    this.baseUrl = `http://127.0.0.1:${port}/`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = null;
    this.baseUrl = null;
    if (!http) return;
    // fetch keeps connections alive; drop them so `close` resolves promptly.
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  /** The loopback URL the mock is listening on. */
  get url(): string {
    if (!this.baseUrl) throw new Error("MockSorobanRpc is not listening; call listen() or MockSorobanRpc.start()");
    return this.baseUrl;
  }

  /** An SDK `rpc.Server` bound to this mock. */
  client(): rpc.Server {
    return new rpc.Server(this.url, { allowHttp: true });
  }

  /**
   * Route `fetch` calls for `targetUrl` (default: every URL) to this mock
   * without a socket, so code that builds its own `rpc.Server` for the real
   * testnet URL is captured too. Returns a function that restores `fetch`.
   */
  interceptFetch(targetUrl?: string): () => void {
    const original = globalThis.fetch;
    const prefix = targetUrl ? new URL(targetUrl).toString() : null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (prefix && !url.startsWith(prefix)) return original(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const body = init?.body !== undefined && init.body !== null
        ? await new Response(init.body).text()
        : input instanceof Request ? await input.text() : "";
      const reply = await this.handleHttp(method, body);
      return new Response(reply.body, { status: reply.status, headers: reply.headers });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  // ---- ledger state -------------------------------------------------------

  get latestLedger(): number {
    return this.latest;
  }

  get oldestLedger(): number {
    return Math.max(this.genesisLedger, this.latest - this.retentionLedgers + 1);
  }

  /**
   * Close one ledger. Pending transactions are applied in it, then `events`
   * are emitted in it (one synthetic transaction each). Returns the new sequence.
   */
  closeLedger(events: EventFixture[] = []): number {
    this.latest += 1;
    const ledger = this.latest;
    for (const tx of this.pending) this.applyTransaction(tx, ledger);
    this.pending = [];
    for (const event of events) {
      const txIndex = this.nextTxIndex(ledger);
      this.storeEvents([event], ledger, txIndex, toHex(sha256(`event:${ledger}:${txIndex}`)));
    }
    return ledger;
  }

  /** Close `count` empty ledgers (pending transactions land in the first). */
  advanceLedgers(count = 1): number {
    for (let i = 0; i < count; i++) this.closeLedger();
    return this.latest;
  }

  /**
   * Replay an event stream: each batch is emitted in its own freshly closed
   * ledger, the way a guard's activity arrives on chain over time.
   */
  streamEvents(batches: EventFixture[][]): number[] {
    return batches.map((batch) => this.closeLedger(batch));
  }

  /** Record events in the *current* ledger — for seeding history before a test starts polling. */
  seedEvents(events: EventFixture[]): void {
    for (const event of events) {
      const txIndex = this.nextTxIndex(this.latest);
      this.storeEvents([event], this.latest, txIndex, toHex(sha256(`event:${this.latest}:${txIndex}`)));
    }
  }

  setLedgerEntry(entry: LedgerEntryFixture): void {
    this.entries.set(entry.key.toXDR("base64"), {
      xdr: entry.data.toXDR("base64"),
      lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq ?? this.latest,
      ...(entry.liveUntilLedgerSeq !== undefined
        ? { liveUntilLedgerSeq: entry.liveUntilLedgerSeq }
        : entry.key.type === "contractData" || entry.key.type === "contractCode"
          ? { liveUntilLedgerSeq: this.latest + this.retentionLedgers * 30 }
          : {}),
    });
  }

  deleteLedgerEntry(key: xdr.LedgerKey): void {
    this.entries.delete(key.toXDR("base64"));
  }

  // ---- scripting ----------------------------------------------------------

  /**
   * Answer matching `simulateTransaction` calls with a fixture. Later
   * registrations take precedence, so a test can override a default.
   */
  onSimulate(match: InvocationMatcher, responder: SimulationResponder, options: ScriptOptions = {}): void {
    this.simulations.unshift({ match, value: responder, remaining: options.times ?? Infinity });
  }

  /** Script the next `sendTransaction` answer(s). Unscripted sends are PENDING and succeed. */
  onSend(outcome: SendOutcome, options: ScriptOptions = { times: 1 }): void {
    this.sends.push({ value: outcome, remaining: options.times ?? Infinity });
  }

  /** Fail the next request(s) — optionally only for one method — before any handler runs. */
  injectFault(fault: Fault, options: ScriptOptions & { method?: string } = {}): void {
    this.faults.push({ value: fault, remaining: options.times ?? 1, method: options.method ?? null });
  }

  /** Answer the next request(s) with HTTP 429, as a rate-limiting RPC gateway does. */
  rateLimit(options: { times?: number; method?: string; retryAfterSeconds?: number } = {}): void {
    this.injectFault(
      {
        kind: "http",
        status: 429,
        body: "429 Too Many Requests",
        headers: { "retry-after": String(options.retryAfterSeconds ?? 1), "content-type": "text/plain" },
      },
      { times: options.times ?? 1, ...(options.method ? { method: options.method } : {}) },
    );
  }

  /** Forget every script and fault (ledger state and history are kept). */
  resetScripts(): void {
    this.simulations = [];
    this.sends = [];
    this.faults = [];
  }

  callCount(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }

  // ---- transport ----------------------------------------------------------

  private async serveHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const reply = await this.handleHttp(req.method ?? "GET", Buffer.concat(chunks).toString("utf8"));
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  }

  /**
   * The whole server minus the socket: an HTTP method and raw body in, an
   * HTTP response out. Exposed so tests can assert on exact wire payloads.
   */
  async handleHttp(method: string, rawBody: string): Promise<MockHttpResponse> {
    if (method !== "POST") {
      return { status: 405, headers: { allow: "POST", "content-type": "text/plain" }, body: "method not allowed" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(200, errorResponse(null, JSON_RPC_ERRORS.parseError, "parse error"));
    }

    // Faults sit in front of dispatch, like a gateway in front of the RPC node.
    const methodName = Array.isArray(payload) ? null : methodOf(payload);
    const fault = this.takeFault(methodName);
    if (fault?.kind === "http") {
      return {
        status: fault.status,
        headers: { "content-type": "text/plain", ...fault.headers },
        body: fault.body ?? "",
      };
    }

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return json(200, errorResponse(null, JSON_RPC_ERRORS.invalidRequest, "empty batch"));
      }
      const replies: JsonRpcResponse[] = [];
      for (const item of payload) {
        const reply = await this.dispatch(item, null);
        if (reply) replies.push(reply);
      }
      return json(200, replies);
    }
    const reply = await this.dispatch(payload, fault);
    // A notification (no id) gets no body, per JSON-RPC 2.0.
    return reply ? json(200, reply) : { status: 204, headers: {}, body: "" };
  }

  /** Handle one decoded JSON-RPC request object. */
  async dispatch(payload: unknown, fault: Fault | null = null): Promise<JsonRpcResponse | null> {
    if (!isJsonRpcRequest(payload)) {
      const id = typeof payload === "object" && payload !== null ? ((payload as { id?: JsonRpcId }).id ?? null) : null;
      return errorResponse(id, JSON_RPC_ERRORS.invalidRequest, "invalid request");
    }
    const id = payload.id ?? null;
    this.requests.push({ method: payload.method, params: payload.params ?? null, id });
    const isNotification = payload.id === undefined;
    try {
      if (fault?.kind === "rpcError") throw new RpcError(fault.code, fault.message);
      const result = await this.route(payload.method, payload.params);
      return isNotification ? null : { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof RpcError) return errorResponse(id, error.code, error.message);
      return errorResponse(id, JSON_RPC_ERRORS.internalError, error instanceof Error ? error.message : String(error));
    }
  }

  private route(method: string, params: unknown): unknown {
    switch (method) {
      case "getHealth":
        return this.getHealth();
      case "getNetwork":
        return this.getNetwork();
      case "getLatestLedger":
        return this.getLatestLedger();
      case "getLedgerEntries":
        return this.getLedgerEntries(params);
      case "getEvents":
        return this.getEvents(params);
      case "simulateTransaction":
        return this.simulateTransaction(params);
      case "sendTransaction":
        return this.sendTransaction(params);
      case "getTransaction":
        return this.getTransaction(params);
      default:
        throw new RpcError(JSON_RPC_ERRORS.methodNotFound, "method not found");
    }
  }

  private takeFault(method: string | null): Fault | null {
    const index = this.faults.findIndex((fault) => fault.method === null || fault.method === method);
    if (index === -1) return null;
    const script = this.faults[index]!;
    script.remaining -= 1;
    if (script.remaining <= 0) this.faults.splice(index, 1);
    return script.value;
  }

  // ---- methods ------------------------------------------------------------

  private getHealth() {
    return {
      status: "healthy",
      latestLedger: this.latest,
      oldestLedger: this.oldestLedger,
      ledgerRetentionWindow: this.retentionLedgers,
    };
  }

  private getNetwork() {
    return {
      passphrase: this.passphrase,
      protocolVersion: this.protocolVersion,
      friendbotUrl: "https://friendbot.stellar.org/",
    };
  }

  private getLatestLedger() {
    const wire = ledgerWire(this.latest, this.protocolVersion);
    return {
      id: wire.id,
      protocolVersion: this.protocolVersion,
      sequence: this.latest,
      closeTime: String(ledgerCloseTime(this.latest)),
      headerXdr: wire.headerXdr,
      metadataXdr: wire.metadataXdr,
    };
  }

  private getLedgerEntries(params: unknown) {
    const keys = objectParam(params).keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "no keys specified");
    }
    if (keys.length > MAX_LEDGER_KEYS) {
      throw new RpcError(
        JSON_RPC_ERRORS.invalidParams,
        `key count (${keys.length}) exceeds maximum supported (${MAX_LEDGER_KEYS})`,
      );
    }
    const entries = [];
    for (const [index, key] of keys.entries()) {
      if (typeof key !== "string") throw new RpcError(JSON_RPC_ERRORS.invalidParams, `cannot unmarshal key value ${index}`);
      let canonical: string;
      try {
        canonical = xdr.LedgerKey.fromXDR(key, "base64").toXDR("base64");
      } catch {
        throw new RpcError(JSON_RPC_ERRORS.invalidParams, `cannot unmarshal key value ${key} at index ${index}`);
      }
      const stored = this.entries.get(canonical);
      if (!stored) continue;
      entries.push({ key: canonical, ...stored });
    }
    return { entries, latestLedger: this.latest };
  }

  private getEvents(params: unknown) {
    const request = objectParam(params);
    const pagination = (request.pagination ?? {}) as { cursor?: unknown; limit?: unknown };
    const cursor = typeof pagination.cursor === "string" && pagination.cursor !== "" ? pagination.cursor : null;
    const limit = pagination.limit === undefined ? DEFAULT_EVENT_LIMIT : Number(pagination.limit);
    const startLedger = request.startLedger === undefined ? null : Number(request.startLedger);
    const endLedger = request.endLedger === undefined ? null : Number(request.endLedger);
    const filters = (request.filters ?? []) as Array<{ type?: string; contractIds?: string[]; topics?: string[][] }>;

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "limit must be positive");
    }
    if (limit > MAX_EVENT_LIMIT) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, `limit must not exceed ${MAX_EVENT_LIMIT}`);
    }
    if (filters.length > MAX_EVENT_FILTERS) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, `maximum ${MAX_EVENT_FILTERS} filters per request`);
    }
    if (cursor !== null && startLedger !== null) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "ledger ranges and cursor cannot both be set");
    }
    if (cursor === null) {
      if (startLedger === null || !Number.isInteger(startLedger) || startLedger <= 0) {
        throw new RpcError(JSON_RPC_ERRORS.invalidParams, "startLedger must be positive");
      }
      if (startLedger < this.oldestLedger || startLedger > this.latest) {
        throw new RpcError(
          JSON_RPC_ERRORS.invalidParams,
          `startLedger must be between the oldest ledger: ${this.oldestLedger} and the latest ledger: ${this.latest}`,
        );
      }
      if (endLedger !== null && endLedger <= startLedger) {
        throw new RpcError(JSON_RPC_ERRORS.invalidParams, "startLedger must be less than endLedger");
      }
    } else if (!/^\d{19}-\d{10}$/.test(cursor)) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, `invalid cursor: ${cursor}`);
    }

    const rangeEnd = endLedger ?? this.latest + 1; // exclusive
    const matched = this.events.filter((event) => {
      if (event.ledger < this.oldestLedger || event.ledger > this.latest) return false;
      if (cursor !== null) {
        if (event.id <= cursor) return false;
      } else if (event.ledger < startLedger! || event.ledger >= rangeEnd) {
        return false;
      }
      return filters.length === 0 || filters.some((filter) => matchesFilter(event, filter));
    });
    const page = matched.slice(0, limit);
    // A full page hands back the last event's id; an exhausted scan hands back
    // the end of the scanned range, so the next poll starts after it.
    const nextCursor =
      page.length === limit
        ? page[page.length - 1]!.id
        : eventId(Math.min(rangeEnd, this.latest + 1), 0, 0, 0);

    return {
      events: page.map((event) => ({
        type: event.type,
        ledger: event.ledger,
        ledgerClosedAt: new Date(ledgerCloseTime(event.ledger) * 1000).toISOString().replace(".000Z", "Z"),
        contractId: event.contractId,
        id: event.id,
        operationIndex: 0,
        transactionIndex: event.txIndex,
        txHash: event.txHash,
        inSuccessfulContractCall: event.inSuccessfulContractCall,
        topic: event.topicXdr,
        value: event.valueXdr,
      })),
      cursor: nextCursor,
      latestLedger: this.latest,
      oldestLedger: this.oldestLedger,
      latestLedgerCloseTime: String(ledgerCloseTime(this.latest)),
      oldestLedgerCloseTime: String(ledgerCloseTime(this.oldestLedger)),
    };
  }

  private simulateTransaction(params: unknown) {
    const envelope = objectParam(params).transaction;
    const invocation = this.decodeInvocation(envelope);
    const script = this.simulations.find((candidate) => matches(candidate.match, invocation));
    if (!script) {
      return {
        error: `mock soroban rpc: no simulateTransaction fixture registered for ${invocation.contractId}.${invocation.fn}()`,
        events: [],
        latestLedger: this.latest,
      };
    }
    script.remaining -= 1;
    if (script.remaining <= 0) this.simulations.splice(this.simulations.indexOf(script), 1);
    const fixture = typeof script.value === "function" ? script.value(invocation) : script.value;

    if (fixture.kind === "error") {
      return {
        error: fixture.error,
        events: (fixture.events ?? []).map((event) => diagnosticEventXdr(event, false)),
        latestLedger: this.latest,
      };
    }
    return {
      transactionData: emptySorobanDataXdr(),
      minResourceFee: fixture.minResourceFee ?? "90000",
      events: (fixture.events ?? []).map((event) => diagnosticEventXdr(event, true)),
      results: [
        {
          auth: (fixture.auth ?? []).map((entry) => entry.toXDR("base64")),
          xdr: fixture.retval.toXDR("base64"),
        },
      ],
      latestLedger: this.latest,
    };
  }

  private sendTransaction(params: unknown) {
    const envelopeXdr = objectParam(params).transaction;
    const tx = this.decodeEnvelope(envelopeXdr);
    const hash = toHex(tx.hash());
    const outcome = this.takeSend();
    const base = { hash, latestLedger: this.latest, latestLedgerCloseTime: String(ledgerCloseTime(this.latest)) };

    if (outcome.status === "ERROR") {
      return {
        ...base,
        status: "ERROR",
        errorResultXdr: rejectedResultXdr(outcome.code),
        ...(outcome.events?.length
          ? { diagnosticEventsXdr: outcome.events.map((event) => diagnosticEventXdr(event, false)) }
          : {}),
      };
    }
    if (outcome.status === "TRY_AGAIN_LATER") return { ...base, status: "TRY_AGAIN_LATER" };
    if (outcome.status === "DUPLICATE" || this.transactions.has(hash)) return { ...base, status: "DUPLICATE" };

    const stored: StoredTransaction = {
      hash,
      envelopeXdr: envelopeXdr as string,
      outcome,
      ledger: null,
      applicationOrder: 0,
    };
    this.transactions.set(hash, stored);
    this.pending.push(stored);
    return { ...base, status: "PENDING" };
  }

  private getTransaction(params: unknown) {
    const hash = objectParam(params).hash;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "unexpected hash length");
    }
    let stored = this.transactions.get(hash.toLowerCase());
    if (stored && stored.ledger === null && this.autoCloseOnPoll) {
      this.closeLedger();
      stored = this.transactions.get(hash.toLowerCase());
    }
    const base = {
      latestLedger: this.latest,
      latestLedgerCloseTime: String(ledgerCloseTime(this.latest)),
      oldestLedger: this.oldestLedger,
      oldestLedgerCloseTime: String(ledgerCloseTime(this.oldestLedger)),
    };
    if (!stored || stored.ledger === null || stored.ledger < this.oldestLedger) {
      return { ...base, status: "NOT_FOUND", txHash: hash };
    }
    const success = stored.outcome.result !== "failed";
    const retval = stored.outcome.retval ?? xdr.ScVal.scvVoid();
    const events = success ? (stored.outcome.events ?? []) : [];
    return {
      ...base,
      status: success ? "SUCCESS" : "FAILED",
      txHash: stored.hash,
      applicationOrder: stored.applicationOrder,
      feeBump: false,
      envelopeXdr: stored.envelopeXdr,
      resultXdr: includedResultXdr(success, retval),
      resultMetaXdr: transactionMetaXdr(success ? retval : null, events),
      ledger: stored.ledger,
      createdAt: String(ledgerCloseTime(stored.ledger)),
      events: {
        contractEventsXdr: [events.map((event) => contractEvent(event).toXDR("base64"))],
        transactionEventsXdr: [],
      },
      ...(success ? {} : { diagnosticEventsXdr: [] }),
    };
  }

  // ---- internals ----------------------------------------------------------

  private takeSend(): SendOutcome {
    const script = this.sends[0];
    if (!script) return { status: "PENDING" };
    script.remaining -= 1;
    if (script.remaining <= 0) this.sends.shift();
    return script.value;
  }

  private nextTxIndex(ledger: number): number {
    const next = (this.txCounts.get(ledger) ?? 0) + 1;
    this.txCounts.set(ledger, next);
    return next;
  }

  private applyTransaction(tx: StoredTransaction, ledger: number): void {
    tx.ledger = ledger;
    tx.applicationOrder = this.nextTxIndex(ledger);
    if (tx.outcome.result !== "failed" && tx.outcome.events?.length) {
      this.storeEvents(tx.outcome.events, ledger, tx.applicationOrder, tx.hash);
    }
  }

  private storeEvents(events: EventFixture[], ledger: number, txIndex: number, txHash: string): void {
    events.forEach((event, eventIndex) => {
      this.events.push({
        id: eventId(ledger, txIndex, 0, eventIndex),
        ledger,
        txIndex,
        txHash,
        type: event.type ?? "contract",
        contractId: event.contractId,
        topicXdr: event.topics.map((topic) => topic.toXDR("base64")),
        valueXdr: (event.value ?? xdr.ScVal.scvMap([])).toXDR("base64"),
        inSuccessfulContractCall: true,
      });
    });
    this.events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private decodeEnvelope(envelope: unknown): Transaction | FeeBumpTransaction {
    if (typeof envelope !== "string" || envelope === "") {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "missing transaction envelope");
    }
    try {
      return TransactionBuilder.fromXDR(envelope, this.passphrase);
    } catch (error) {
      throw new RpcError(
        JSON_RPC_ERRORS.invalidParams,
        `could not unmarshal transaction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private decodeInvocation(envelope: unknown): Invocation {
    const decoded = this.decodeEnvelope(envelope);
    const tx = "innerTransaction" in decoded ? decoded.innerTransaction : decoded;
    if (tx.operations.length !== 1) {
      throw new RpcError(
        JSON_RPC_ERRORS.invalidParams,
        "Transaction contains more than one operation (simulation supports exactly one)",
      );
    }
    const raw = xdr.TransactionEnvelope.fromXDR(tx.toXDR(), "base64");
    const body = (raw.type === "envelopeTypeTx" ? raw.v1.tx.operations[0]?.body : undefined);
    if (!body || body.type !== "invokeHostFunction") {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "Transaction contains unsupported operation type");
    }
    const hostFunction = body.invokeHostFunctionOp.hostFunction;
    if (hostFunction.type !== "hostFunctionTypeInvokeContract") {
      // Uploads and deploys are not scripted by contract/function; answer by kind.
      return { contractId: "", fn: hostFunction.type, args: [], source: tx.source };
    }
    const call = hostFunction.invokeContract;
    return {
      contractId: Address.fromScAddress(call.contractAddress).toString(),
      fn: String(call.functionName),
      args: call.args,
      source: tx.source,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): MockHttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<JsonRpcRequest>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

function methodOf(value: unknown): string | null {
  return isJsonRpcRequest(value) ? value.method : null;
}

function objectParam(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new RpcError(JSON_RPC_ERRORS.invalidParams, "invalid parameters");
  }
  return params as Record<string, unknown>;
}

function matches(match: InvocationMatcher, call: Invocation): boolean {
  return (match.contractId === undefined || match.contractId === call.contractId) &&
    (match.fn === undefined || match.fn === call.fn);
}

/**
 * stellar-rpc filter semantics: `type` must match when given; `contractIds`
 * must include the emitter when given; each `topics` entry is a segment list
 * where `*` matches any one topic and a trailing `**` matches any remainder.
 */
function matchesFilter(
  event: StoredEvent,
  filter: { type?: string; contractIds?: string[]; topics?: string[][] },
): boolean {
  if (filter.type && filter.type !== event.type) return false;
  if (filter.contractIds?.length && !filter.contractIds.includes(event.contractId)) return false;
  if (!filter.topics?.length) return true;
  return filter.topics.some((segments) => {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      if (segment === "**") return true;
      if (i >= event.topicXdr.length) return false;
      if (segment !== "*" && segment !== event.topicXdr[i]) return false;
    }
    return segments.length === event.topicXdr.length;
  });
}
