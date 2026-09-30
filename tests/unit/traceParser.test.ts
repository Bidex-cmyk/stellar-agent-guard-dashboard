import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import { parseDiagnosticLogs } from "../../lib/guard/traceParser.ts";
import { MOCK_GUARD, diagnosticEventXdr } from "../mocks/sorobanFixtures.ts";

const sym = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);

/** A `fn_call` diagnostic event, exactly as the host emits it. */
function fnCall(contractId: string, functionName: string, args: xdr.ScVal[] = []): string {
  return diagnosticEventXdr({
    contractId,
    topics: [sym("fn_call"), new Address(contractId).toScVal(), sym(functionName)],
    value: xdr.ScVal.scvVec(args),
  });
}

/** A `fn_return` diagnostic event. */
function fnReturn(value: xdr.ScVal = xdr.ScVal.scvVoid()): string {
  return diagnosticEventXdr({ contractId: MOCK_GUARD, topics: [sym("fn_return")], value });
}

/** An `error` diagnostic event carrying a contract error code. */
function errorEvent(code: number): string {
  return diagnosticEventXdr({
    contractId: MOCK_GUARD,
    topics: [sym("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
    value: xdr.ScVal.scvString("escalating error to VM trap from failed host function call: call"),
  });
}

describe("traceParser", () => {
  test("returns no tree for an empty event list", () => {
    assert.deepEqual(parseDiagnosticLogs([]), { tree: [] });
  });

  test("decodes a guard refusal from a plain host error string", () => {
    const result = parseDiagnosticLogs(["Error(Contract, #100)"]);
    assert.equal(result.tree[0]?.error, "SpendCapExceeded");
  });

  test("decodes a diagnostic object with a numeric guard error", () => {
    const result = parseDiagnosticLogs([
      { type: "diagnostic", contractId: "C123", functionName: "set_policy", args: [], error: 100 },
    ]);
    assert.equal(result.tree[0]?.error, "SpendCapExceeded");
    assert.equal(result.tree[0]?.functionName, "set_policy");
  });

  test("builds a flat call frame from real fn_call/fn_return XDR", () => {
    const tree = parseDiagnosticLogs([fnCall(MOCK_GUARD, "set_policy"), fnReturn()]).tree;

    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.contractId, MOCK_GUARD);
    assert.equal(tree[0]?.functionName, "set_policy");
    assert.equal(tree[0]?.subCalls.length, 0);
    assert.match(tree[0]?.events[0] ?? "", /return:/);
  });

  test("keeps invocation arguments in the frame", () => {
    const tree = parseDiagnosticLogs([
      fnCall(MOCK_GUARD, "transfer", [xdr.ScVal.scvU32(7)]),
      fnReturn(),
    ]).tree;

    assert.deepEqual(tree[0]?.arguments, [7]);
  });

  test("nests deeply nested sub-invocations into call hierarchy trees", () => {
    const tree = parseDiagnosticLogs([
      fnCall(MOCK_GUARD, "set_policy"),
      fnCall(MOCK_GUARD, "check_auth"),
      fnCall(MOCK_GUARD, "record_spend"),
      errorEvent(100),
      fnReturn(),
      fnReturn(),
      fnReturn(),
    ]).tree;

    assert.equal(tree.length, 1, "only the outermost frame is a root");
    const outer = tree[0];
    assert.equal(outer?.functionName, "set_policy");
    const middle = outer?.subCalls[0];
    assert.equal(middle?.functionName, "check_auth");
    const inner = middle?.subCalls[0];
    assert.equal(inner?.functionName, "record_spend");
    assert.equal(inner?.error, "SpendCapExceeded", "the error lands on the deepest frame");
    assert.equal(outer?.error, undefined, "the outer frames stay clean");
    assert.equal(inner?.subCalls.length, 0);
  });

  test("a sibling call after a nested one is attached to the parent, not the child", () => {
    const tree = parseDiagnosticLogs([
      fnCall(MOCK_GUARD, "set_policy"),
      fnCall(MOCK_GUARD, "read_window"),
      fnReturn(),
      fnCall(MOCK_GUARD, "write_policy"),
      fnReturn(),
      fnReturn(),
    ]).tree;

    const outer = tree[0];
    assert.equal(outer?.subCalls.length, 2);
    assert.equal(outer?.subCalls[0]?.functionName, "read_window");
    assert.equal(outer?.subCalls[1]?.functionName, "write_policy");
  });

  test("decodes every common guard error code and keeps unknown ones verbatim", () => {
    const known = parseDiagnosticLogs([errorEvent(100)]).tree[0];
    assert.equal(known?.error, "SpendCapExceeded");

    const unknown = parseDiagnosticLogs([errorEvent(999)]).tree[0];
    assert.equal(unknown?.error, "ContractError#999");
  });

  test("decodes an auth failure from a diagnostic event", () => {
    const tree = parseDiagnosticLogs([
      diagnosticEventXdr({
        contractId: MOCK_GUARD,
        topics: [sym("error"), xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction))],
        value: xdr.ScVal.scvString("failed account authentication with error"),
      }),
    ]).tree;

    assert.equal(tree[0]?.error, "SystemError(scecInvalidAction)");
  });
});
