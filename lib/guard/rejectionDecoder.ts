/**
 * Rejection decoder: converts guard rejection reason codes and simulation
 * diagnostic logs into human explanations with specific numeric thresholds cited.
 *
 * The guard returns structured error codes when it refuses a call (see the
 * SDK's `GUARD_REASON_CODES`: both the numeric enum value and the stable
 * snake_case symbol the contract publishes as an event topic). This module
 * decodes those codes — plus the diagnostic events bundled with a failed
 * enforced simulation — into operator-readable explanations, including the
 * specific policy clause that was violated and the numeric values involved.
 *
 * Like the rest of `lib/guard`, this module is loaded by `node --test`
 * through Node's type-stripping loader, so it avoids constructs that need a
 * build step (no parameter properties, no enums).
 */

/** The set of known guard rejection variants. */
export type RejectionVariant =
  | "CapExceeded"
  | "WindowExceeded"
  | "ContractNotAllowed"
  | "FunctionNotAllowed"
  | "DMSExpired"
  | "GuardFrozen";

/** A decoded rejection with its human explanation and pre-populated policy exception. */
export interface DecodedRejection {
  /** The variant of the rejection. */
  variant: RejectionVariant;
  /** A human-readable explanation with specific thresholds cited. */
  explanation: string;
  /** The original raw reason string from the guard, if available. */
  rawReason: string | null;
  /** A pre-populated policy draft exception for admin review, or null if not applicable. */
  policyException: PolicyException | null;
  /** Numeric thresholds cited in the explanation, when they could be determined. */
  thresholds: { requested?: bigint; cap?: bigint } | null;
  /** The intercepted authorization call tree, with parameter values where known. */
  authCalls: AuthCall[];
  /** Bounded one-line summaries of the diagnostic events this was decoded from. */
  diagnostics: string[];
}

/** A policy exception pre-populated for the PolicyForm. */
export interface PolicyException {
  /** The protocol or recipient to add. */
  target: string;
  /** The field to update in the policy draft. */
  field: "recipients" | "protocols" | "perTxCap" | "windowCap" | "windowSecs" | "dmsGraceSecs" | "assets";
  /** The suggested value. */
  value: string;
}

/** One intercepted authorization call, with parameter values where known. */
export interface AuthCall {
  /** The contract that was called (`C…`), when it could be determined. */
  contract: string | null;
  /** The function that was invoked, when it could be determined. */
  function: string | null;
  /** The call's parameter values as a bounded string, when known. */
  args: string | null;
  /** A one-line rendering of this call for display. */
  detail: string;
}

/** Optional context that lets a rejection cite specific thresholds and calls. */
export interface DecodeContext {
  /** The amount that was requested, in stroops or whole units. */
  requested?: bigint | number | string | null;
  /** The cap that was enforced, in the same units as `requested`. */
  cap?: bigint | number | string | null;
  /** The destination contract (`C…`), when known. */
  contract?: string | null;
  /** The function that was invoked, when known. */
  function?: string | null;
  /** The call's parameter values; rendered as a bounded string. */
  args?: unknown;
  /** Raw simulation diagnostic events to mine for thresholds and call trees. */
  diagnostics?: readonly unknown[] | null;
}

/**
 * Numeric guard error codes, mirroring the SDK's `GUARD_REASON_CODES` and the
 * contract's `Error`/`BlockReason` enum in
 * `stellar-agent-guard-contracts/src/types.rs`.
 */
const CODE_TO_NAME: Record<number, string> = {
  1: "unauthorized",
  2: "already_initialized",
  3: "not_initialized",
  4: "invalid_config",
  5: "invalid_amount",
  10: "admin_frozen",
  11: "heartbeat_expired",
  12: "no_policy",
  13: "paused",
  14: "outside_active_window",
  20: "asset_not_allowed",
  21: "recipient_not_allowed",
  22: "per_tx_cap_exceeded",
  23: "window_cap_exceeded",
  24: "protocol_not_allowed",
  25: "function_not_allowed",
  26: "unknown_contract",
  27: "self_function_not_allowed",
  28: "create_contract_not_allowed",
};

/** Every snake_case reason the dashboard knows how to decode. */
const KNOWN_REASONS = Object.values(CODE_TO_NAME);

/** Maps each known reason name to its inspector variant. */
const NAME_TO_VARIANT: Record<string, RejectionVariant> = {
  per_tx_cap_exceeded: "CapExceeded",
  invalid_amount: "CapExceeded",
  window_cap_exceeded: "WindowExceeded",
  recipient_not_allowed: "ContractNotAllowed",
  protocol_not_allowed: "ContractNotAllowed",
  asset_not_allowed: "ContractNotAllowed",
  unknown_contract: "ContractNotAllowed",
  create_contract_not_allowed: "ContractNotAllowed",
  function_not_allowed: "FunctionNotAllowed",
  self_function_not_allowed: "FunctionNotAllowed",
  unauthorized: "FunctionNotAllowed",
  heartbeat_expired: "DMSExpired",
  outside_active_window: "DMSExpired",
  admin_frozen: "GuardFrozen",
  paused: "GuardFrozen",
  no_policy: "GuardFrozen",
  already_initialized: "GuardFrozen",
  not_initialized: "GuardFrozen",
  invalid_config: "GuardFrozen",
};

/** Dashboard shorthand aliases for the contract's canonical reason names. */
const REASON_ALIASES: Record<string, string> = {
  dms_expired: "heartbeat_expired",
  guard_frozen: "admin_frozen",
  cap_exceeded: "per_tx_cap_exceeded",
  contract_not_allowed: "protocol_not_allowed",
};

/** Normalise a reason code (numeric or snake_case, with surrounding noise tolerated). */
function normaliseReason(reason: string | number | null): string | null {
  if (reason === null) return null;
  if (typeof reason === "number") return CODE_TO_NAME[reason] ?? null;
  const trimmed = reason.trim();
  if (trimmed === "") return null;
  if (KNOWN_REASONS.includes(trimmed)) return trimmed;
  if (Object.hasOwn(REASON_ALIASES, trimmed)) return REASON_ALIASES[trimmed]!;
  if (/^\d{1,3}$/.test(trimmed)) {
    const mapped = CODE_TO_NAME[Number(trimmed)];
    if (mapped) return mapped;
  }
  // Tolerate diagnostic one-liners such as
  // "per_tx_cap_exceeded: 5000000000 > 1000000000" or "Error(22)".
  const lower = trimmed.toLowerCase();
  for (const alias of Object.keys(REASON_ALIASES)) {
    if (lower.includes(alias)) return REASON_ALIASES[alias]!;
  }
  for (const name of KNOWN_REASONS) {
    if (lower.includes(name)) return name;
  }
  const codeMatch = trimmed.match(/(?:error\s*\(?\s*|code\s*[:=]\s*)(\d{1,3})\)?/i);
  if (codeMatch?.[1] !== undefined) {
    const mapped = CODE_TO_NAME[Number(codeMatch[1])];
    if (mapped) return mapped;
  }
  return trimmed;
}

function toBigint(value: bigint | number | string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isInteger(value)) return null;
      return BigInt(value);
    }
    const trimmed = value.trim();
    if (trimmed === "" || !/^-?\d+$/.test(trimmed)) return null;
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function boundedJson(value: unknown, limit = 240): string {
  let text: string;
  try {
    text = JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    text = String(value);
  }
  if (text.length > limit) return `${text.slice(0, limit)}…`;
  return text;
}

/** Render a stroop-scale integer with an XLM hint, so clauses cite real numbers. */
function formatAmount(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10_000_000n;
  const frac = abs % 10_000_000n;
  const prefix = negative ? "-" : "";
  if (abs >= 10_000_000n && frac === 0n) {
    return `${prefix}${whole.toString()} XLM (${prefix}${abs.toString()} stroops)`;
  }
  if (abs >= 10_000_000n) {
    const fracPadded = frac.toString().padStart(7, "0").replace(/0+$/, "");
    return `${prefix}${whole.toString()}.${fracPadded} XLM (${prefix}${abs.toString()} stroops)`;
  }
  return `${prefix}${abs.toString()} stroops`;
}

function shortenAddress(address: string): string {
  if (address.length > 14) return `${address.slice(0, 6)}…${address.slice(-4)}`;
  return address;
}

/** Maps a guard reason code to its decoded form. */
export function decodeRejection(
  reason: string | number | null,
  context: DecodeContext = {},
): DecodedRejection {
  const rawReason = typeof reason === "number" ? String(reason) : reason;
  const name = normaliseReason(reason);

  const fromDiagnostics = extractThresholdsFromDiagnostics(context.diagnostics ?? null);
  const fromReason = extractThresholds(rawReason);
  const requested = toBigint(context.requested) ?? fromReason?.requested ?? fromDiagnostics?.requested ?? null;
  const cap = toBigint(context.cap) ?? fromReason?.cap ?? fromDiagnostics?.cap ?? null;
  const thresholds = requested !== null || cap !== null
    ? { ...(requested !== null ? { requested } : {}), ...(cap !== null ? { cap } : {}) }
    : null;

  const contract = context.contract?.trim() || fromDiagnostics?.contract || null;
  const fn = context.function?.trim() || fromDiagnostics?.function || null;
  const diagnosticEvents = context.diagnostics ?? [];
  const diagnostics = diagnosticSummaries(diagnosticEvents);
  const parsedCalls = parseAuthCallTree(diagnosticEvents);
  const authCalls: AuthCall[] =
    parsedCalls.length > 0
      ? parsedCalls
      : contract !== null || fn !== null || context.args !== undefined
        ? [
            {
              contract,
              function: fn,
              args: context.args !== undefined ? boundedJson(context.args) : null,
              detail: describeCall(contract, fn, context.args !== undefined ? boundedJson(context.args) : null),
            },
          ]
        : [];

  if (name === null) {
    return {
      variant: "CapExceeded",
      explanation:
        rawReason === null
          ? "The transaction was blocked but no specific reason was provided."
          : `Unknown rejection reason: ${String(rawReason).slice(0, 240)}. The guard blocked this transaction.`,
      rawReason,
      policyException: null,
      thresholds,
      authCalls,
      diagnostics,
    };
  }

  const variant: RejectionVariant = NAME_TO_VARIANT[name] ?? "CapExceeded";
  if (!Object.hasOwn(NAME_TO_VARIANT, name)) {
    return {
      variant: "CapExceeded",
      explanation: `Unknown rejection reason: ${name}. The guard blocked this transaction.`,
      rawReason,
      policyException: null,
      thresholds,
      authCalls,
      diagnostics,
    };
  }

  switch (variant) {
    case "CapExceeded": {
      const clause =
        requested !== null && cap !== null
          ? `Requested ${formatAmount(requested)} exceeds per-tx cap of ${formatAmount(cap)}.`
          : "Requested amount exceeds the per-transaction cap.";
      return {
        variant,
        explanation:
          `${clause} The guard rejected this call because it would exceed the per-tx limit.` +
          (contract ? ` Destination ${shortenAddress(contract)} was not the problem — the amount was.` : ""),
        rawReason,
        policyException: {
          field: "perTxCap",
          target: "per-tx cap",
          value: requested !== null ? requested.toString() : "",
        },
        thresholds,
        authCalls,
        diagnostics,
      };
    }
    case "WindowExceeded": {
      const clause =
        requested !== null && cap !== null
          ? `Requested ${formatAmount(requested)} would push cumulative spend over the rolling window cap of ${formatAmount(cap)}.`
          : "Requested amount exceeds the rolling window cap.";
      return {
        variant,
        explanation: `${clause} The guard rejected this call because it would exceed the cumulative window limit.`,
        rawReason,
        policyException: {
          field: "windowCap",
          target: "window cap",
          value: requested !== null ? requested.toString() : "",
        },
        thresholds,
        authCalls,
        diagnostics,
      };
    }
    case "ContractNotAllowed": {
      const short = contract ? shortenAddress(contract) : null;
      const clause =
        contract !== null
          ? `Destination contract ${contract} is not in allowed protocols.`
          : "Destination contract is not in the allowlist.";
      const assetLike = name === "asset_not_allowed";
      return {
        variant,
        explanation:
          `${clause} The guard rejected this call because the ${assetLike ? "asset" : "recipient"} is not an allowed address.` +
          (short && contract ? ` (${short})` : ""),
        rawReason,
        policyException: {
          field: assetLike ? "assets" : name === "protocol_not_allowed" || name === "unknown_contract" || name === "create_contract_not_allowed" ? "protocols" : "recipients",
          target: contract ?? "recipient",
          value: contract ?? "",
        },
        thresholds,
        authCalls,
        diagnostics,
      };
    }
    case "FunctionNotAllowed": {
      const clause =
        contract !== null && fn !== null
          ? `Function ${fn} on contract ${contract} is not in the contract's allowed function list.`
          : "The invoked function is not in the contract's allowed function list.";
      return {
        variant,
        explanation: `${clause} The guard rejected this call because the function is not permitted for this contract.`,
        rawReason,
        policyException: {
          field: "protocols",
          target: contract ?? "protocol",
          value: contract && fn ? `${contract}:${fn}` : (contract ?? ""),
        },
        thresholds,
        authCalls,
        diagnostics,
      };
    }
    case "DMSExpired": {
      return {
        variant,
        explanation:
          "The dead-man switch has expired. " +
          "The guard rejected this call because the configured dead-man grace period has elapsed.",
        rawReason,
        policyException: {
          field: "dmsGraceSecs",
          target: "dms grace",
          value: "",
        },
        thresholds,
        authCalls,
        diagnostics,
      };
    }
    case "GuardFrozen": {
      return {
        variant,
        explanation:
          "The guard is frozen. " +
          "The guard rejected this call because the admin has frozen the guard contract.",
        rawReason,
        policyException: null,
        thresholds,
        authCalls,
        diagnostics,
      };
    }
  }
}

/**
 * Decode a refusal out of raw simulation diagnostic events.
 *
 * Returns `null` when none of the events carries a recognisable guard reason,
 * so callers can distinguish "no refusal here" from "a refusal with an
 * unrecognised reason".
 */
export function decodeRejectionFromDiagnostics(
  events: readonly unknown[] | null | undefined,
  fallbackReason: string | number | null = null,
): DecodedRejection | null {
  if (!events || events.length === 0) {
    if (fallbackReason === null) return null;
    return decodeRejection(fallbackReason, { diagnostics: [] });
  }
  const joined = events.map((event) => safeJson(event)).join("\n");
  const lower = joined.toLowerCase();
  for (const name of KNOWN_REASONS) {
    if (lower.includes(name)) {
      return decodeRejection(name, { diagnostics: events });
    }
  }
  for (const code of Object.keys(CODE_TO_NAME).map(Number)) {
    const pattern = new RegExp(`(?:error\\s*\\(?\\s*|code\\s*[:=]\\s*)${code}\\)?`, "i");
    if (pattern.test(joined)) {
      const mapped = CODE_TO_NAME[code];
      if (mapped) return decodeRejection(mapped, { diagnostics: events });
    }
  }
  if (fallbackReason !== null) return decodeRejection(fallbackReason, { diagnostics: events });
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/**
 * Parses a numeric threshold from a raw reason string.
 *
 * Some reason strings include the actual values (e.g., "500 exceeds 100" or
 * "per_tx_cap_exceeded: 5000000000 > 1000000000"). This extracts the numbers
 * for display. Returns null if no numbers are found.
 */
export function extractThresholds(reason: string | number | null): { requested?: bigint; cap?: bigint } | null {
  if (reason === null) return null;
  if (typeof reason === "number") return null;
  const numbers = reason.match(/\d+/g);
  if (!numbers || numbers.length < 1) return null;
  const result: { requested?: bigint; cap?: bigint } = {};
  if (numbers.length >= 1 && numbers[0] !== undefined) result.requested = BigInt(numbers[0]);
  if (numbers.length >= 2 && numbers[1] !== undefined) result.cap = BigInt(numbers[1]);
  return result;
}

function extractThresholdsFromDiagnostics(
  events: readonly unknown[] | null,
): { requested?: bigint; cap?: bigint; contract?: string | null; function?: string | null } | null {
  if (!events || events.length === 0) return null;
  const joined = events.map((event) => safeJson(event)).join("\n");
  const numbers = joined.match(/\d{2,}/g);
  const result: { requested?: bigint; cap?: bigint; contract?: string | null; function?: string | null } = {};
  if (numbers && numbers.length >= 2) {
    try {
      const asBig = numbers.map((n) => BigInt(n)).filter((n) => n > 0n);
      // Heuristic: the two largest distinct integers in a cap diagnostic are
      // the requested amount and the enforced cap.
      const distinct = [...new Set(asBig)].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      if (distinct.length >= 2 && distinct[0] !== undefined && distinct[1] !== undefined) {
        result.requested = distinct[0];
        result.cap = distinct[1];
      } else if (distinct.length === 1 && distinct[0] !== undefined) {
        result.requested = distinct[0];
      }
    } catch {
      // Ignore unparseable numbers; thresholds stay absent.
    }
  }
  const contractMatch = joined.match(/C[A-Z0-9]{55}/);
  if (contractMatch?.[0]) result.contract = contractMatch[0];
  return Object.keys(result).length > 0 ? result : null;
}

function describeCall(contract: string | null, fn: string | null, args: string | null): string {
  const where = contract ?? "unknown contract";
  const what = fn ?? "unknown function";
  const withArgs = args ? `(${args})` : "()";
  return `${where} :: ${what}${withArgs}`;
}

/**
 * Parse the intercepted authorization call tree out of raw diagnostic events.
 *
 * Tolerates the several shapes the RPC and the SDK use for the same event
 * (decoded `xdr.DiagnosticEvent` instances, bare event objects, or base64 XDR
 * strings in a JSON error payload) by working from the JSON rendering rather
 * than any one object shape.
 */
export function parseAuthCallTree(events: readonly unknown[] | null | undefined): AuthCall[] {
  if (!events || events.length === 0) return [];
  const calls: AuthCall[] = [];
  for (const event of events) {
    const text = safeJson(event);
    if (!/fn_call|invoke|contract|function|symbol/i.test(text)) continue;
    const contractMatch = text.match(/C[A-Z0-9]{55}/);
    const fnMatch =
      text.match(/"(?:function|fn|fname|symbol)"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/) ??
      text.match(/fn_call[^A-Za-z0-9_]{1,12}([A-Za-z_][A-Za-z0-9_]*)/i);
    const contract = contractMatch?.[0] ?? null;
    const fn = fnMatch?.[1] ?? null;
    if (contract === null && fn === null) continue;
    const args = boundedJson(event);
    calls.push({ contract, function: fn, args, detail: describeCall(contract, fn, args) });
  }
  return calls;
}

/** Bounded one-line summaries of diagnostic events, for display in the modal. */
export function diagnosticSummaries(events: readonly unknown[], limit = 8): string[] {
  return events.slice(0, limit).map((event) => boundedJson(event));
}
