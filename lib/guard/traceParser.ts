import { scValToNative, xdr } from "@stellar/stellar-sdk";

/** One contract invocation in a simulation trace, with its nested sub-calls. */
export interface TraceNode {
  contractId: string;
  functionName: string;
  arguments: unknown[];
  error?: string;
  /** Return values and log lines emitted while this frame was on the stack. */
  events: string[];
  subCalls: TraceNode[];
}

export interface ParsedDiagnostic {
  tree: TraceNode[];
}

/**
 * The guard's `Error` enum, decoded to names an operator can act on. Only codes
 * the contract actually raises are listed; anything else is rendered verbatim as
 * `ContractError#<n>` rather than being guessed at.
 */
const GUARD_ERROR_CODES: Record<number, string> = {
  100: "SpendCapExceeded",
};

export function decodeGuardError(code: number): string {
  return GUARD_ERROR_CODES[code] ?? `ContractError#${code}`;
}

type Normalized =
  | { kind: "call"; contractId: string; functionName: string; args: unknown[] }
  | { kind: "return"; value: unknown }
  | { kind: "error"; error: string; contractId?: string; functionName?: string }
  | { kind: "log"; message: string; contractId?: string; functionName?: string };

/** `scValToNative` on a non-ScVal is a programming error, not a trace failure. */
function native(value: unknown): unknown {
  try {
    return scValToNative(value as xdr.ScVal);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function render(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/** Decode a `Error(Contract, #N)` / `Error(Auth, …)` topic, falling back to text. */
function describeError(errorScVal: unknown, message: unknown): string {
  const decoded = native(errorScVal) as
    { type?: string; code?: number; value?: string } | undefined;
  if (decoded && typeof decoded === "object") {
    if (decoded.type === "contract" && typeof decoded.code === "number") {
      return decodeGuardError(decoded.code);
    }
    if (decoded.type === "system") {
      return `SystemError(${decoded.value ?? decoded.code ?? "unknown"})`;
    }
  }

  const text = typeof message === "string" ? message : message === undefined ? "" : String(message);
  const contract = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  if (contract?.[1]) return decodeGuardError(Number(contract[1]));
  const auth = /Error\(Auth,\s*(\w+)\)/.exec(text);
  if (auth?.[1]) return `AuthError(${auth[1]})`;
  return "UnknownError";
}

/** Turn a decoded `ContractEvent` into a normalized trace step. */
function normalizeContractEvent(event: unknown): Normalized | null {
  const candidate = asRecord(event);
  if (!candidate) return null;
  const body = asRecord(candidate.body);
  if (!body) return null;

  let topics: unknown[] | undefined;
  let data: unknown;
  if (body.type === "v0") {
    const v0 = asRecord(body.v0);
    if (!v0) return null;
    topics = Array.isArray(v0.topics) ? v0.topics : [];
    data = v0.data;
  } else if (Array.isArray(candidate.topics)) {
    // Already-decoded event object rather than a wrapped XDR union.
    topics = candidate.topics;
    data = candidate.data;
  } else {
    return null;
  }

  const head = topics[0] === undefined ? undefined : native(topics[0]);
  if (head === "fn_call") {
    const contractId = topics[1] === undefined ? "C_UNKNOWN" : String(native(topics[1]));
    const functionName = topics[2] === undefined ? "unknown" : String(native(topics[2]));
    const argsVal = native(data);
    const args = Array.isArray(argsVal) ? argsVal : argsVal === undefined ? [] : [argsVal];
    return { kind: "call", contractId, functionName, args };
  }
  if (head === "fn_return") {
    return { kind: "return", value: native(data) };
  }
  if (head === "error") {
    return { kind: "error", error: describeError(topics[1], native(data)) };
  }
  if (head === "log") {
    return { kind: "log", message: String(native(data) ?? "") };
  }
  return null;
}

/** Try hard to make sense of one raw event, whatever shape it arrives in. */
function normalize(event: unknown): Normalized | null {
  if (typeof event === "string") {
    try {
      return normalizeContractEvent(xdr.DiagnosticEvent.fromXdr(event, "base64").event);
    } catch {
      // Not XDR: the host renders errors as plain text in some responses.
      const contract = /Error\(Contract,\s*#(\d+)\)/.exec(event);
      if (contract?.[1]) return { kind: "error", error: decodeGuardError(Number(contract[1])) };
      const auth = /Error\(Auth,\s*(\w+)\)/.exec(event);
      if (auth?.[1]) return { kind: "error", error: `AuthError(${auth[1]})` };
      return { kind: "log", message: event };
    }
  }

  const record = asRecord(event);
  if (!record) return null;

  // A wrapped DiagnosticEvent: dig into `.event`.
  if (record.event !== undefined) {
    const inner = normalizeContractEvent(record.event);
    if (inner) return inner;
  }

  const kind = record.type ?? record.kind;
  const contractId = typeof record.contractId === "string" ? record.contractId : undefined;
  const functionName = typeof record.functionName === "string" ? record.functionName : undefined;

  if (kind === "fn_call" || kind === "call") {
    return {
      kind: "call",
      contractId: contractId ?? "C_UNKNOWN",
      functionName: functionName ?? "unknown",
      args: Array.isArray(record.arguments)
        ? record.arguments
        : Array.isArray(record.args)
          ? record.args
          : [],
    };
  }
  if (kind === "fn_return") {
    return { kind: "return", value: record.value };
  }
  if (kind === "error" || kind === "diagnostic") {
    const code = record.error;
    if (typeof code === "number") {
      return {
        kind: "error",
        error: decodeGuardError(code),
        ...(contractId !== undefined && { contractId }),
        ...(functionName !== undefined && { functionName }),
      };
    }
    if (typeof code === "string") {
      return {
        kind: "error",
        error: code,
        ...(contractId !== undefined && { contractId }),
        ...(functionName !== undefined && { functionName }),
      };
    }
    return {
      kind: "error",
      error: describeError(record.errorScVal, record.message ?? record.data),
      ...(contractId !== undefined && { contractId }),
      ...(functionName !== undefined && { functionName }),
    };
  }
  if (kind === "log") {
    return {
      kind: "log",
      message: String(record.message ?? record.data ?? ""),
      ...(contractId !== undefined && { contractId }),
      ...(functionName !== undefined && { functionName }),
    };
  }

  return normalizeContractEvent(event);
}

/**
 * Parse a simulation's diagnostic events into the contract call hierarchy they
 * describe: `fn_call` opens a frame, `fn_return` closes it, and an `error`/`log`
 * attaches to whatever frame is currently on the stack. This is what lets an
 * operator see *where* in a nested call a guard refusal happened, not just that
 * the transaction failed.
 */
export function parseDiagnosticLogs(events: unknown[]): ParsedDiagnostic {
  if (!events || events.length === 0) return { tree: [] };

  const tree: TraceNode[] = [];
  const stack: TraceNode[] = [];

  const syntheticNode = (input: { contractId?: string; functionName?: string }): TraceNode => {
    const node: TraceNode = {
      contractId: input.contractId ?? "C_UNKNOWN",
      functionName: input.functionName ?? "unknown",
      arguments: [],
      events: [],
      subCalls: [],
    };
    tree.push(node);
    return node;
  };

  for (const raw of events) {
    const step = normalize(raw);
    if (!step) continue;

    if (step.kind === "call") {
      const node: TraceNode = {
        contractId: step.contractId,
        functionName: step.functionName,
        arguments: step.args,
        events: [],
        subCalls: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.subCalls.push(node);
      else tree.push(node);
      stack.push(node);
    } else if (step.kind === "return") {
      const frame = stack.pop();
      if (frame) {
        frame.events.push(`return: ${render(step.value)}`);
      } else {
        syntheticNode({}).events.push(`return: ${render(step.value)}`);
      }
    } else if (step.kind === "error") {
      const frame = stack[stack.length - 1] ?? syntheticNode(step);
      frame.error = step.error;
    } else {
      const frame = stack[stack.length - 1] ?? syntheticNode(step);
      frame.events.push(step.message);
    }
  }

  return { tree };
}
