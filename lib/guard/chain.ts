import { getCachedByteLength, getCachedHash, setCachedHash } from "./bytecodeCache.ts";
/**
 * Read-only access to a guard deployment, straight off Soroban RPC.
 *
 * Everything here is a simulation or a ledger read: nothing in this module can
 * mutate state, which is why the dashboard is willing to call it on every render
 * and on a polling interval. Bytes and hashes are handled with `Uint8Array` and
 * Web Crypto only, so the same code runs in the browser and in Node.
 */

import {
  Account,
  Address,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type xdr as Xdr,
} from "@stellar/stellar-sdk";
import { NETWORK, PHASE1_ARTIFACT, READ_SOURCE_FALLBACK } from "./network.ts";
import { bytesToHex, guardStorageLedgerKeys, hashToHex, sha256, sha256Hex } from "./scval.ts";
import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";

export function createServer(rpcUrl: string = NETWORK.rpcUrl): rpc.Server {
  return new rpc.Server(rpcUrl);
}

/** A read succeeded, or it produced a real error. There is deliberately no third case. */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run a read-only contract function and decode its return value.
 *
 * Uses `Operation.invokeContractFunction` with pre-encoded `ScVal` arguments
 * rather than a spec-typed `Contract.call`, so a struct argument (the policy)
 * crosses the boundary exactly as `policyToScVal` built it.
 */
export async function readContract<T = unknown>(
  server: rpc.Server,
  contractId: string,
  fn: string,
  args: Xdr.ScVal[] = [],
  source: string = READ_SOURCE_FALLBACK,
): Promise<ReadResult<T>> {
  try {
    const account = new Account(source, "0");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK.passphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({ contract: contractId, function: fn, args }),
      )
      .setTimeout(30)
      .build();
    const simulation = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      return { ok: false, error: stringifyError(simulation.error) };
    }
    const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
    const retval = success.result?.retval;
    if (retval === undefined) {
      return { ok: false, error: `simulation of ${fn}() returned no value` };
    }
    return { ok: true, value: scValToNative(retval) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readStatus(server: rpc.Server, guard: string, source?: string): Promise<ReadResult<GuardStatus>> {
  return readContract<GuardStatus>(server, guard, "status", [], source);
}

/** The installed policy, or `null` for the contract's default-deny state. */
export function readPolicy(
  server: rpc.Server,
  guard: string,
  source?: string,
): Promise<ReadResult<PolicyConfig | null>> {
  return readContract<PolicyConfig | null>(server, guard, "policy", [], source);
}

/** One of the guard's own persistent storage entries (e.g. the rolling `Window`). */
export async function readPersistentEntry<T = unknown>(
  server: rpc.Server,
  contractId: string,
  dataKeyName: string,
): Promise<ReadResult<T | null>> {
  try {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(dataKeyName)]),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const response = await server.getLedgerEntries(key);
    const entry = response.entries[0] as unknown as {
      val?: { contractData?: { val?: Xdr.ScVal } | (() => { val?: () => Xdr.ScVal }) };
    } | undefined;
    if (!entry?.val) return { ok: true, value: null };
    // The decoded XDR wrapper exposes `contractData` as a plain property in this
    // SDK build, but keep the callable shape working too rather than pinning to
    // one internal representation.
    const contractData =
      typeof entry.val.contractData === "function"
        ? entry.val.contractData()
        : entry.val.contractData;
    const scval =
      typeof contractData?.val === "function" ? contractData.val() : contractData?.val;
    if (!scval) return { ok: true, value: null };
    return { ok: true, value: scValToNative(scval) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The rolling-window spend ledger. No read function exposes it; it is internal accounting. */
export interface WindowState {
  total: bigint;
  entries: Array<{ ts: bigint; amount: bigint }>;
}

export async function readWindow(server: rpc.Server, guard: string): Promise<ReadResult<WindowState | null>> {
  const raw = await readPersistentEntry<WindowState>(server, guard, "Window");
  if (!raw.ok) return raw;
  if (raw.value === null || raw.value === undefined) return { ok: true, value: null };
  return { ok: true, value: raw.value };
}

export interface WasmIdentity {
  /** The hash the ledger reports for the contract's instance. */
  reportedWasmHash: string | null;
  /** SHA-256 recomputed over the bytecode fetched from the chain. */
  fetchedSha256: string;
  bytes: number;
  /** True when the ledger's declared hash and the fetched bytes agree. */
  match: boolean;
}

/**
 * The cache namespace for a server. `rpc.Server` exposes its endpoint as a
 * `URL`, so it has to be stringified before it can be inspected.
 */
function networkCacheKey(server: rpc.Server): string {
  const endpoint = (server as unknown as { serverURL?: URL | string }).serverURL;
  const text = endpoint instanceof URL ? endpoint.toString() : String(endpoint ?? "");
  return text.includes("testnet") ? "testnet" : "public";
}

/**
 * Verify that a deployed contract really runs the bytecode the ledger claims.
 *
 * `getContractWasmByContractId` returns the stored code; hashing it here is an
 * independent check, because the ledger keys `ContractCode` by the hash of the
 * uploaded bytes. This is the check that makes "we deployed the proven artifact"
 * a fact rather than an assertion.
 */
export async function verifyWasmIdentity(
  server: rpc.Server,
  contractId: string,
): Promise<WasmIdentity> {
  const instance = (await server.getContractInstance(contractId)) as unknown as {
    executable?: { wasmHash?: unknown };
  };
  const reportedWasmHash = hashToHex(instance.executable?.wasmHash);

  // Contract code is immutable, so an unchanged instance lets us skip the
  // (large) WASM download and the SHA-256 over it.
  const networkKey = networkCacheKey(server);
  const cachedHash = getCachedHash(networkKey, contractId);

  if (cachedHash) {
    return {
      reportedWasmHash,
      fetchedSha256: cachedHash,
      bytes: getCachedByteLength(networkKey, contractId) ?? 0,
      match: reportedWasmHash === cachedHash,
    };
  }

  const wasm = await server.getContractWasmByContractId(contractId);
  const bytes = toBytes(wasm);
  const fetchedSha256 = await sha256Hex(bytes);
  setCachedHash(networkKey, contractId, fetchedSha256, bytes.length);

  return {
    reportedWasmHash,
    fetchedSha256,
    bytes: bytes.length,
    match: reportedWasmHash === fetchedSha256,
  };
}

/** The exact bytecode of a deployed contract, fetched from the chain. */
export async function fetchContractWasm(
  server: rpc.Server,
  contractId: string,
): Promise<Uint8Array> {
  return toBytes(await server.getContractWasmByContractId(contractId));
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  const candidate = value as { buffer?: unknown };
  if (candidate?.buffer) return new Uint8Array(candidate.buffer as ArrayBuffer);
  throw new Error("RPC returned contract bytecode in an unrecognised shape");
}

/**
 * The address `create_custom_contract` will produce for a given deployer and
 * salt: `sha256(HashIdPreimage::ContractId { network_id, preimage })`.
 *
 * Computing it locally means the operator is told the guard's address *before*
 * signing the deploy, and the address is then confirmed by reading the instance
 * back off the ledger — so a deploy cannot silently land somewhere unexpected.
 */
export async function predictContractId(params: {
  deployerPublicKey: string;
  salt: Uint8Array;
  passphrase?: string;
}): Promise<string> {
  const passphrase = params.passphrase ?? NETWORK.passphrase;
  const networkId = await sha256(new TextEncoder().encode(passphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(params.deployerPublicKey).toScAddress(),
          salt: params.salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(await sha256(new Uint8Array(preimage.toXDR())));
}

/** Does the contract's own storage say `initialize` has already run? */
export async function isInitialized(server: rpc.Server, guard: string): Promise<boolean> {
  const instance = await server.getContractInstance(guard);
  const decoded = JSON.parse(JSON.stringify(instance)) as {
    storage?: Array<{ key?: { vec?: Array<{ symbol?: string; sym?: string }> }; val?: unknown }>;
  };
  for (const item of decoded.storage ?? []) {
    const first = item.key?.vec?.[0];
    if ((first?.symbol ?? first?.sym) !== "Initialized") continue;
    const value = item.val as { bool?: boolean } | string | undefined;
    if (typeof value === "string") return value.includes("true");
    return value?.bool === true;
  }
  return false;
}

/** True when a contract call failed because `initialize` had already run (#2). */
export function isAlreadyInitializedError(detail: string): boolean {
  return /Error\(Contract, #2\)/.test(detail) || detail.includes("error code: 2");
}

/** The SDK's `Contract` helper, for callers that want spec-typed reads. */
export function contractAt(contractId: string): Contract {
  return new Contract(contractId);
}

/**
 * The build's own commitment to the artifact it deploys: the bytes Phase 1
 * proved. Used by the deploy flow as an assertion, and by tests as a constant.
 */
export function pinnedArtifact() {
  return { ...PHASE1_ARTIFACT };
}

export { bytesToHex };
export { stringifyError };

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
