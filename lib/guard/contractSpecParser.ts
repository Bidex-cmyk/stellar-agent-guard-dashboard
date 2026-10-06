/**
 * The contract-spec reader: turns on-chain WASM bytecode into the list of
 * exported functions an operator can allowlist.
 *
 * Soroban build tooling embeds a machine-readable description of every contract
 * function in a WASM *custom section* named `contractspecv0`: a concatenated
 * stream of `SCSpecEntry` XDR values, one per function, user-defined type, and
 * event. The policy form's per-function allowlist is only as good as the symbol
 * strings an operator types into it, so this module replaces the typing with a
 * read: fetch the bytecode, walk the custom sections, decode the stream, and
 * offer exactly the names the contract will actually accept.
 *
 * Two hard rules shape the code:
 *
 *  1. Never trust the spec more than the contract it describes. The section is
 *     untrusted input from the chain, so every decode step is wrapped and a
 *     corrupt stream yields a graceful "no spec" result, not a crashed render.
 *  2. Do not reorder or rename anything. A function name is matched by the
 *     guard byte-for-byte against the host's invoke, so names are surfaced
 *     exactly as the spec spells them, in spec order.
 *
 * Like the rest of `lib/guard`, this module is isomorphic: `Uint8Array` and
 * `TextDecoder` only, no `node:crypto` and no `Buffer`, so the same code parses
 * fixtures under `node --test` and live bytecode in the browser.
 */

import { xdr } from "@stellar/stellar-sdk";

/** The WASM custom section carrying the concatenated `SCSpecEntry` stream. */
export const CONTRACT_SPEC_SECTION = "contractspecv0";

/**
 * A function the contract exports, as its spec describes it.
 *
 * `inputs` is rendered next to each option in the picker, because a signature
 * like `swap(trader: Address, amount_in: I128)` is what stops an operator from
 * allowlisting a function whose call shape they did not expect.
 */
export interface SpecFunction {
  /** The exact exported symbol; matched by the guard byte-for-byte. */
  name: string;
  /** Declared parameter names and Soroban type names, in declaration order. */
  inputs: Array<{ name: string; type: string }>;
  /** The Soroban return type, or `null` for a void function. */
  output: string | null;
  /** The doc comment from the source, when the contract published one. */
  doc: string;
}

/** The outcome of parsing a contract's WASM. */
export type ContractSpecResult =
  | { ok: true; functions: SpecFunction[] }
  | { ok: false; reason: SpecMissingReason; message: string };

/**
 * Why a contract's spec could not be read.
 *
 * `stripped` is the case the form must fall back on: some deployers remove
 * custom sections to shrink the binary. Such a contract is *valid* — it
 * deploys and runs — so the form falls back to manual entry with a warning
 * rather than treating the contract as broken.
 */
export type SpecMissingReason =
  | /** Not WASM at all: bad magic, or a version that is not 1. */ "invalid-wasm"
  | /** Valid WASM with the `contractspecv0` custom section removed. */ "stripped"
  | /** The section exists but its XDR stream does not decode. */ "corrupt";

const SPEC_MISSING_MESSAGES: Record<SpecMissingReason, string> = {
  "invalid-wasm": "The bytes on chain are not a WebAssembly module.",
  stripped:
    "This contract was deployed without an embedded interface spec (the contractspecv0 custom section was removed), so its function list cannot be read automatically. Type function symbols manually, separated by commas.",
  corrupt:
    "The contract's interface spec is present but could not be decoded, so its function list cannot be read automatically. Type function symbols manually, separated by commas.",
};

/** Decode a WASM module header, or return `null` when the bytes are not WASM. */
function readWasmHeader(wasm: Uint8Array): { offset: number } | null {
  // `\0asm` followed by the version 1, little-endian. Anything else cannot be
  // walked as a section stream, so refuse it before reading further.
  const magic = [0x00, 0x61, 0x73, 0x6d];
  const version = [0x01, 0x00, 0x00, 0x00];
  if (wasm.length < 8) return null;
  for (let index = 0; index < 4; index++) {
    if (wasm[index] !== magic[index]) return null;
  }
  for (let index = 0; index < 4; index++) {
    if (wasm[4 + index] !== version[index]) return null;
  }
  return { offset: 8 };
}

/**
 * Read one LEB128 `u32`, the width WASM uses for section sizes and names.
 * Returns the value and the offset just past it, or `null` when the encoding
 * is malformed (truncated, over-long, or exceeding 32 bits).
 */
function readVarUint32(
  bytes: Uint8Array,
  offset: number,
): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (offset >= bytes.length) return null;
    const byte = bytes[offset]!;
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      // In the final group of a 5-byte encoding only the low 4 bits fit a u32.
      if (shift >= 28 && (byte & 0x70) !== 0) return null;
      return { value: value >>> 0, offset };
    }
    shift += 7;
    if (shift > 28) return null;
  }
}

/**
 * Every custom section of a WASM module, by name.
 *
 * Custom sections (id 0) are the only extension point the format offers, so
 * the spec and the contract's embedded metadata both arrive this way.
 * Malformed section boundaries end the walk rather than throwing: a hostile
 * binary is parsed exactly as far as it is parseable.
 */
export function parseWasmCustomSections(wasm: Uint8Array): Map<string, Uint8Array[]> {
  const sections = new Map<string, Uint8Array[]>();
  const header = readWasmHeader(wasm);
  if (!header) return sections;

  let offset = header.offset;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  while (offset < wasm.length) {
    const sectionId = wasm[offset]!;
    const size = readVarUint32(wasm, offset + 1);
    if (!size) return sections;
    const start = size.offset;
    // A section cannot extend past the module; stop trusting the stream here.
    if (start + size.value > wasm.length) return sections;

    if (sectionId === 0) {
      const nameLength = readVarUint32(wasm, start);
      if (nameLength && nameLength.offset + nameLength.value <= start + size.value) {
        const nameStart = nameLength.offset;
        const nameEnd = nameStart + nameLength.value;
        try {
          const name = decoder.decode(wasm.subarray(nameStart, nameEnd));
          const payloadStart = nameEnd;
          const payloadEnd = start + size.value;
          if (payloadEnd > payloadStart) {
            // `slice` copies, so no payload ever aliases the caller's bytes.
            const payload = wasm.slice(payloadStart, payloadEnd);
            const existing = sections.get(name);
            if (existing) existing.push(payload);
            else sections.set(name, [payload]);
          }
        } catch {
          // A name that is not valid UTF-8 cannot be a spec section; skip it.
        }
      }
    }
    offset = start + size.value;
  }
  return sections;
}

/** Render one `SCSpecTypeDef` the way the SDK names it (e.g. `Address`, `Vec<Address>`). */
function describeTypeDef(type: xdr.ScSpecTypeDef): string {
  const suffix = type.type.replace(/^scSpecType/, "");
  // The union's payload is a plain property in this SDK generation. Composite
  // types name their shape, not just their variant, because `Vec<Address>` and
  // `Vec<I128>` are different call shapes an operator should be able to see.
  switch (type.type) {
    case "scSpecTypeOption":
      return `Option<${describeTypeDef(type.value.valueType)}>`;
    case "scSpecTypeVec":
      return `Vec<${describeTypeDef(type.value.elementType)}>`;
    case "scSpecTypeMap":
      return `Map<${describeTypeDef(type.value.keyType)}, ${describeTypeDef(type.value.valueType)}>`;
    case "scSpecTypeTuple":
      return `Tuple<${type.value.valueTypes.map(describeTypeDef).join(", ")}>`;
    case "scSpecTypeBytesN":
      return `BytesN<${type.value.n}>`;
    case "scSpecTypeUdt":
      return type.value.name.toString();
    case "scSpecTypeResult":
      return `Result<${describeTypeDef(type.value.okType)}>`;
    default:
      return suffix;
  }
}

/** One function entry from the stream, or `null` for anything else. */
function specFunctionFromEntry(entry: xdr.ScSpecEntry): SpecFunction | null {
  if (entry.type !== "scSpecEntryFunctionV0") return null;
  // `entry.value` is typed loosely on the union; narrow by variant name and
  // treat shape drift between SDK versions as "not a function entry" rather
  // than a crash.
  const candidate = entry.value as unknown;
  if (!candidate || typeof candidate !== "object") return null;
  const fn = candidate as {
    name?: { toString?(): string };
    doc?: { toString?(): string };
    inputs?: Array<{ name?: { toString?(): string }; type?: xdr.ScSpecTypeDef }>;
    outputs?: Array<xdr.ScSpecTypeDef>;
  };
  const name = fn.name?.toString?.();
  if (!name) return null;
  return {
    name,
    inputs: (fn.inputs ?? []).map((input) => ({
      name: input.name?.toString?.() ?? "",
      type: input.type ? describeTypeDef(input.type) : "?",
    })),
    output: fn.outputs && fn.outputs.length > 0 ? describeTypeDef(fn.outputs[0]!) : null,
    doc: fn.doc?.toString?.() ?? "",
  };
}

/**
 * Decode the concatenated `SCSpecEntry` stream from a `contractspecv0` payload.
 *
 * The fast path is the SDK's own stream decoder — the same one
 * `Spec.fromWasm` relies on — which requires the payload to be exactly one
 * concatenated entry stream. When that fails (a truncated or patched tail),
 * a greedy recovery scans for each entry's 4-byte-aligned boundary: XDR
 * fields are 4-byte aligned, so every real entry boundary lies on that grid,
 * and a prefix that decodes exactly is a boundary. Entries decoded before the
 * corruption are real, so they are returned; only an undecodable first entry
 * gives up entirely.
 */
export function decodeSpecEntryStream(payload: Uint8Array): xdr.ScSpecEntry[] {
  try {
    return xdr.decodeStream(xdr.ScSpecEntry, payload);
  } catch {
    // Fall through to greedy recovery.
  }
  const entries: xdr.ScSpecEntry[] = [];
  let offset = 0;
  while (offset + 4 <= payload.length) {
    let decoded: xdr.ScSpecEntry | null = null;
    // Bound the scan per entry: a spec entry is at most a few hundred bytes,
    // so 4096 bytes is far past any real entry and caps the cost of garbage.
    const scanEnd = Math.min(payload.length, offset + 4096);
    for (let end = offset + 4; end <= scanEnd; end += 4) {
      try {
        decoded = xdr.ScSpecEntry.fromXdr(payload.subarray(offset, end));
        break;
      } catch {
        decoded = null;
      }
    }
    if (!decoded) break;
    entries.push(decoded);
    offset += decoded.toXdr().byteLength;
  }
  return entries;
}

/**
 * Parse a contract's WASM into its exported functions.
 *
 * This is the whole feature in one call: header check, custom-section walk,
 * spec decode. Every failure mode is a typed result, because the form has to
 * decide between "show the picker" (spec present) and "fall back to manual
 * entry with a warning" (spec absent), and neither is an exception.
 */
export function parseContractSpec(wasm: Uint8Array): ContractSpecResult {
  if (!readWasmHeader(wasm)) {
    return { ok: false, reason: "invalid-wasm", message: SPEC_MISSING_MESSAGES["invalid-wasm"] };
  }
  const payloads = parseWasmCustomSections(wasm).get(CONTRACT_SPEC_SECTION);
  if (!payloads || payloads.length === 0) {
    return { ok: false, reason: "stripped", message: SPEC_MISSING_MESSAGES.stripped };
  }
  const entries = payloads.flatMap((payload) => decodeSpecEntryStream(payload));
  const functions = entries
    .map(specFunctionFromEntry)
    .filter((fn): fn is SpecFunction => fn !== null);
  // A section that is present but yields nothing is not an empty-but-valid
  // spec; it is a section we failed to read. Distinguishing the two is what
  // lets the form show the right warning.
  if (functions.length === 0) {
    return { ok: false, reason: "corrupt", message: SPEC_MISSING_MESSAGES.corrupt };
  }
  return { ok: true, functions };
}

/**
 * The constructor `__constructor` never appears in an invoke path the guard
 * authorizes, so the picker filters it out.
 */
export const HIDDEN_FUNCTION_NAMES: ReadonlySet<string> = new Set(["__constructor"]);

/**
 * The distinct exported function names of a parsed spec, in spec order,
 * deduplicated, with constructor entries removed.
 */
export function exportedFunctionNames(result: ContractSpecResult): string[] {
  if (!result.ok) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const fn of result.functions) {
    if (HIDDEN_FUNCTION_NAMES.has(fn.name)) continue;
    if (seen.has(fn.name)) continue;
    seen.add(fn.name);
    names.push(fn.name);
  }
  return names;
}

/** A one-line signature like `transfer(from: Address, to: Address, amount: I128) -> Void`. */
export function formatSpecSignature(fn: SpecFunction): string {
  const params = fn.inputs.map((input) => `${input.name}: ${input.type}`).join(", ");
  const output = fn.output ?? "Void";
  return `${fn.name}(${params}) -> ${output}`;
}

/**
 * The first sentence of a spec doc comment, flattened for a picker row.
 *
 * Returns `""` when the contract published no doc: the row then shows the
 * signature alone rather than an empty annotation.
 */
export function firstDocSentence(fn: SpecFunction): string {
  const flat = fn.doc.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentence = flat.split(/(?<=[.!?])\s/, 1)[0] ?? flat;
  return sentence.length > 0 ? sentence : flat;
}
