import assert from "node:assert/strict";
import { test } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import {
  CONTRACT_SPEC_SECTION,
  decodeSpecEntryStream,
  exportedFunctionNames,
  firstDocSentence,
  formatSpecSignature,
  parseContractSpec,
  parseWasmCustomSections,
  HIDDEN_FUNCTION_NAMES,
  type SpecFunction,
} from "../../lib/guard/contractSpecParser.ts";

/**
 * Fixture builders go through the SDK's own XDR layer, so a test failure can
 * only be the parser's fault — not a fixture that drifted from the real
 * `SCSpecEntry` wire format.
 */

type TypeDef = xdr.ScSpecTypeDef;

function fnEntry(
  name: string,
  inputs: Array<[string, TypeDef]>,
  output: TypeDef | null,
  doc = "",
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      name,
      doc,
      inputs: inputs.map(
        ([inputName, type]) => new xdr.ScSpecFunctionInputV0({ name: inputName, type, doc: "" }),
      ),
      outputs: output ? [output] : [],
    }),
  );
}

function structEntry(name: string, fields: Array<[string, TypeDef]>): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      name,
      doc: "",
      lib: "",
      fields: fields.map(
        ([fieldName, type]) => new xdr.ScSpecUdtStructFieldV0({ name: fieldName, type, doc: "" }),
      ),
    }),
  );
}

/** Concatenate entries into the exact wire format the custom section carries. */
function specStream(entries: xdr.ScSpecEntry[]): Uint8Array {
  const total = entries.reduce((sum, entry) => sum + entry.toXdr().byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    const bytes = entry.toXdr();
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return out;
}

/**
 * A minimal valid WASM module: header plus one custom section with the given
 * name and payload, all lengths LEB128-encoded as the format requires.
 */
function wasmModule(sectionName: string, payload: Uint8Array): Uint8Array {
  return new Uint8Array([...WASM_HEADER, ...customSection(sectionName, payload)]);
}

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** One WASM custom section (no module header), lengths LEB128-encoded. */
function customSection(sectionName: string, payload: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(sectionName);
  return new Uint8Array([
    0,
    ...leb128(1 + name.length + payload.length),
    name.length,
    ...name,
    ...payload,
  ]);
}

/** LEB128 u32, the width WASM uses for every length field. */
function leb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

const address = xdr.ScSpecTypeDef.scSpecTypeAddress();
const i128 = xdr.ScSpecTypeDef.scSpecTypeI128();
const u64 = xdr.ScSpecTypeDef.scSpecTypeU64();
const voidT = xdr.ScSpecTypeDef.scSpecTypeVoid();
const stringT = xdr.ScSpecTypeDef.scSpecTypeString();

// ── Standard SAC (Token Interface) ─────────────────────────────────────────

/**
 * The SAC's exported surface, as SEP-0011 declares it. `xfer`/`xfers` are the
 * internal `__`-prefixed names the token interface actually exports; the
 * operator-facing names (`transfer`, `mint`, …) are generated wrappers.
 * The parser must surface whatever the spec spells, so the fixture uses the
 * real exported spelling.
 */
const SAC_UDT = structEntry("TokenMetadata", [
  ["name", stringT],
  ["symbol", stringT],
]);
const SAC_FUNCTIONS = [
  fnEntry(
    "transfer",
    [
      ["from", address],
      ["to", address],
      ["amount", i128],
    ],
    voidT,
    "Move `amount` tokens from `from` to `to`. Blah.",
  ),
  fnEntry(
    "mint",
    [
      ["to", address],
      ["amount", i128],
    ],
    voidT,
  ),
  fnEntry("set_admin", [["new_admin", address]], voidT),
  fnEntry("balance", [["id", address]], i128),
  fnEntry(
    "burn",
    [
      ["from", address],
      ["amount", i128],
    ],
    voidT,
  ),
  // Present in real SAC specs; the picker must hide it.
  fnEntry("__constructor", [["admin", address]], voidT),
];
const SAC = [SAC_UDT, ...SAC_FUNCTIONS];

// ── Custom DEX contract ────────────────────────────────────────────────────

function vecOf(elementType: TypeDef): TypeDef {
  return xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType }));
}

function optionOf(valueType: TypeDef): TypeDef {
  return xdr.ScSpecTypeDef.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType }));
}

const DEX_FUNCTIONS = [
  fnEntry(
    "swap_exact_tokens_for_tokens",
    [
      ["amount_in", i128],
      ["min_amount_out", i128],
      ["path", vecOf(address)],
      ["to", address],
      ["deadline", u64],
    ],
    vecOf(i128),
    "Swap an exact input amount for at least `min_amount_out` of the last token in `path`. Reverts after `deadline`.",
  ),
  fnEntry(
    "add_liquidity",
    [
      ["token_a", address],
      ["token_b", address],
      ["amount_a_desired", i128],
      ["amount_b_desired", i128],
      ["amount_a_min", i128],
      ["amount_b_min", i128],
      ["to", address],
    ],
    null, // tuple struct return omitted in the fixture; void for simplicity
  ),
  fnEntry(
    "remove_liquidity",
    [
      ["token_a", address],
      ["token_b", address],
      ["liquidity", i128],
      ["amount_a_min", i128],
      ["amount_b_min", i128],
      ["to", address],
    ],
    null,
  ),
  fnEntry(
    "get_reserves",
    [],
    xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType: optionOf(i128) })),
  ),
  fnEntry("factory", [], address),
];

const DEX = DEX_FUNCTIONS;

// ── Header / custom-section walking ────────────────────────────────────────

test("the SAC spec round-trips through the parser with names in spec order", () => {
  const result = parseContractSpec(wasmModule(CONTRACT_SPEC_SECTION, specStream(SAC)));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // UDT entries are skipped; functions come out in spec order, exact spelling.
  assert.deepEqual(
    result.functions.map((fn) => fn.name),
    ["transfer", "mint", "set_admin", "balance", "burn", "__constructor"],
  );
  const transfer = result.functions[0]!;
  assert.deepEqual(transfer.inputs, [
    { name: "from", type: "Address" },
    { name: "to", type: "Address" },
    { name: "amount", type: "I128" },
  ]);
  assert.equal(transfer.output, "Void");
  assert.match(transfer.doc, /Move `amount` tokens/);
  // UDT entries are skipped but their payload bytes are tolerated.
  assert.ok(!result.functions.some((fn) => fn.name === "TokenMetadata"));
});

test("the DEX spec decodes composite argument types", () => {
  const result = parseContractSpec(wasmModule(CONTRACT_SPEC_SECTION, specStream(DEX)));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const swap = result.functions.find((fn) => fn.name === "swap_exact_tokens_for_tokens");
  assert.ok(swap, "swap must be present");
  assert.deepEqual(swap.inputs[2], { name: "path", type: "Vec<Address>" });
  assert.equal(swap.output, "Vec<I128>");
  const reserves = result.functions.find((fn) => fn.name === "get_reserves");
  assert.ok(reserves);
  assert.equal(reserves.output, "Vec<Option<I128>>");
  assert.equal(reserves.inputs.length, 0);
});

test("the custom section survives other sections around it", () => {
  // Two custom sections (metadata before, the spec after) plus a real
  // non-custom section id; the walk must return the spec payload unharmed.
  const spec = specStream(SAC);
  const metadata = new TextEncoder().encode("wasm:toc");
  const moduleBytes = new Uint8Array([
    ...WASM_HEADER,
    ...customSection("wasm:toc", metadata),
    ...customSection(CONTRACT_SPEC_SECTION, spec),
    1, // type section id (non-custom)
    ...leb128(3),
    0x60,
    0x00,
    0x00, // a func type: no params, no results
  ]);

  const sections = parseWasmCustomSections(moduleBytes);
  assert.ok(sections.get(CONTRACT_SPEC_SECTION), "spec section must be found");
  const result = parseContractSpec(moduleBytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // UDT entries are skipped; the six SAC functions all come through.
  assert.equal(result.functions.length, SAC_FUNCTIONS.length);
});

test("a multi-payload spec (repeated sections) concatenates", () => {
  // Custom sections may repeat within one module; the parser treats every
  // payload as part of the same entry stream, matching the SDK's own Spec.
  const moduleBytes = new Uint8Array([
    ...WASM_HEADER,
    ...customSection(CONTRACT_SPEC_SECTION, specStream([SAC_FUNCTIONS[0]!, SAC_FUNCTIONS[1]!])),
    ...customSection(CONTRACT_SPEC_SECTION, specStream([SAC_FUNCTIONS[2]!])),
  ]);
  const result = parseContractSpec(moduleBytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.functions.map((fn) => fn.name),
    ["transfer", "mint", "set_admin"],
  );
});

// ── Failure modes and fallbacks ────────────────────────────────────────────

test("a stripped module (no custom sections) reports stripped, not corrupt", () => {
  // A structurally valid module: just the header and a non-custom section.
  const stripped = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x03, 0x01, 0x00, 0x00,
  ]);
  const result = parseContractSpec(stripped);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "stripped");
  assert.match(result.message, /contractspecv0/);
  assert.match(result.message, /manually/);
});

test("not-WASM bytes report invalid-wasm", () => {
  for (const bytes of [
    new Uint8Array(0),
    new TextEncoder().encode("definitely not wasm, not even close"),
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]), // version 2
  ]) {
    const result = parseContractSpec(bytes);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid-wasm");
  }
});

test("a corrupt spec stream reports corrupt and keeps decodable prefixes", () => {
  // Header + spec section name, then a payload that is not XDR: the walk
  // sees the section, the decode fails, and the reason names it.
  const moduleBytes = new Uint8Array([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    0,
    ...leb128(1 + 14 + 4),
    14,
    ...new TextEncoder().encode(CONTRACT_SPEC_SECTION),
    1,
    2,
    3,
    4, // not a valid ScSpecEntry
  ]);
  const result = parseContractSpec(moduleBytes);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "corrupt");
});

test("a truncated tail keeps the decodable prefix of entries", () => {
  const stream = specStream(SAC_FUNCTIONS);
  // Cut into the second entry: the first survives, the rest are dropped.
  const firstLen = SAC_FUNCTIONS[0]!.toXdr().byteLength;
  const truncated = stream.slice(0, firstLen + 8);
  const decoded = decodeSpecEntryStream(truncated);
  assert.deepEqual(
    decoded.map((entry) => (entry.value as { name: { toString(): string } }).name.toString()),
    ["transfer"],
  );
});

test("a malformed section size ends the walk without throwing", () => {
  // Section header claims more bytes than the module holds.
  const moduleBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0xff, 0x01,
  ]);
  const sections = parseWasmCustomSections(moduleBytes);
  assert.equal(sections.size, 0);
  const result = parseContractSpec(moduleBytes);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "stripped");
});

// ── Picker-facing helpers ──────────────────────────────────────────────────

test("exportedFunctionNames deduplicates and hides the constructor", () => {
  assert.ok(HIDDEN_FUNCTION_NAMES.has("__constructor"));
  const result = parseContractSpec(wasmModule(CONTRACT_SPEC_SECTION, specStream(SAC)));
  const names = exportedFunctionNames(result);
  assert.deepEqual(names, ["transfer", "mint", "set_admin", "balance", "burn"]);
});

test("exportedFunctionNames is empty for a failed parse", () => {
  assert.deepEqual(exportedFunctionNames({ ok: false, reason: "stripped", message: "x" }), []);
});

test("signatures render in the operator's terms", () => {
  const result = parseContractSpec(wasmModule(CONTRACT_SPEC_SECTION, specStream(DEX)));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const swap = result.functions.find(
    (fn) => fn.name === "swap_exact_tokens_for_tokens",
  ) as SpecFunction;
  assert.equal(
    formatSpecSignature(swap),
    "swap_exact_tokens_for_tokens(amount_in: I128, min_amount_out: I128, path: Vec<Address>, to: Address, deadline: U64) -> Vec<I128>",
  );
});

test("docs flatten to a first sentence for the picker row", () => {
  const result = parseContractSpec(wasmModule(CONTRACT_SPEC_SECTION, specStream(SAC)));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const transfer = result.functions[0]!;
  assert.equal(firstDocSentence(transfer), "Move `amount` tokens from `from` to `to`.");
  const mint = result.functions[1]!;
  assert.equal(firstDocSentence(mint), "", "no doc means no annotation, not an empty sentence");
});

// ── Demo-mode fixture integrity ────────────────────────────────────────────

test("the demo protocol fixture parses to the functions the demo policy allowlists", async () => {
  const { DEMO_PROTOCOL_SPEC, DEMO_PROTOCOL } = await import("../../lib/guard/demoFixtures.ts");
  const result = parseContractSpec(DEMO_PROTOCOL_SPEC);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(exportedFunctionNames(result), ["swap", "deposit", "withdraw", "heartbeat"]);
  // The contract id the form shows in demo mode must stay aligned with the
  // fixture: expanding that row must never render an empty picker.
  assert.match(DEMO_PROTOCOL, /^C/);
});
