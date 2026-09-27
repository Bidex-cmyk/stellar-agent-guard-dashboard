import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeRejection,
  decodeRejectionFromDiagnostics,
  diagnosticSummaries,
  extractThresholds,
  parseAuthCallTree,
} from "../../lib/guard/rejectionDecoder";

describe("decodeRejection", () => {
  it("decodes per_tx_cap_exceeded as CapExceeded", () => {
    const result = decodeRejection("per_tx_cap_exceeded");
    assert.equal(result.variant, "CapExceeded");
    assert.ok(result.explanation.includes("per-transaction cap"));
    assert.equal(result.rawReason, "per_tx_cap_exceeded");
    assert.equal(result.policyException?.field, "perTxCap");
  });

  it("decodes window_cap_exceeded as WindowExceeded", () => {
    const result = decodeRejection("window_cap_exceeded");
    assert.equal(result.variant, "WindowExceeded");
    assert.ok(result.explanation.includes("rolling window cap"));
    assert.equal(result.rawReason, "window_cap_exceeded");
    assert.equal(result.policyException?.field, "windowCap");
  });

  it("decodes recipient_not_allowed as ContractNotAllowed", () => {
    const result = decodeRejection("recipient_not_allowed");
    assert.equal(result.variant, "ContractNotAllowed");
    assert.ok(result.explanation.includes("allowlist"));
    assert.equal(result.rawReason, "recipient_not_allowed");
    assert.equal(result.policyException?.field, "recipients");
  });

  it("decodes function_not_allowed as FunctionNotAllowed", () => {
    const result = decodeRejection("function_not_allowed");
    assert.equal(result.variant, "FunctionNotAllowed");
    assert.ok(result.explanation.includes("function is not permitted"));
    assert.equal(result.rawReason, "function_not_allowed");
    assert.equal(result.policyException?.field, "protocols");
  });

  it("decodes dms_expired as DMSExpired", () => {
    const result = decodeRejection("dms_expired");
    assert.equal(result.variant, "DMSExpired");
    assert.ok(result.explanation.includes("dead-man switch"));
    assert.equal(result.rawReason, "dms_expired");
  });

  it("decodes guard_frozen as GuardFrozen", () => {
    const result = decodeRejection("guard_frozen");
    assert.equal(result.variant, "GuardFrozen");
    assert.ok(result.explanation.includes("frozen"));
    assert.equal(result.rawReason, "guard_frozen");
    assert.equal(result.policyException, null);
  });

  it("returns null-reason variant with a fallback explanation for unknown reasons", () => {
    const result = decodeRejection("some_unknown_reason");
    assert.equal(result.variant, "CapExceeded");
    assert.ok(result.explanation.includes("Unknown rejection reason"));
    assert.equal(result.rawReason, "some_unknown_reason");
    assert.equal(result.policyException, null);
  });

  it("returns a fallback explanation for null reason", () => {
    const result = decodeRejection(null);
    assert.equal(result.variant, "CapExceeded");
    assert.ok(result.explanation.includes("no specific reason"));
    assert.equal(result.rawReason, null);
    assert.equal(result.policyException, null);
  });
});

describe("extractThresholds", () => {
  it("extracts two numbers from a reason string", () => {
    const result = extractThresholds("500 exceeds 100");
    assert.equal(result?.requested, 500n);
    assert.equal(result?.cap, 100n);
  });

  it("extracts one number from a reason string", () => {
    const result = extractThresholds("1000");
    assert.equal(result?.requested, 1000n);
    assert.equal(result?.cap, undefined);
  });

  it("returns null for strings with no numbers", () => {
    const result = extractThresholds("no numbers here");
    assert.equal(result, null);
  });

  it("returns null for null input", () => {
    const result = extractThresholds(null);
    assert.equal(result, null);
  });
});

describe("decodeRejection with demo events", () => {
  it("decodes all known demo blocked reasons", () => {
    const reasons = ["per_tx_cap_exceeded", "recipient_not_allowed", "window_cap_exceeded"];
    for (const reason of reasons) {
      const result = decodeRejection(reason);
      assert.ok(result.variant.length > 0, `reason ${reason} should have a variant`);
      assert.ok(result.explanation.length > 0, `reason ${reason} should have an explanation`);
    }
  });
});

describe("decodeRejection edge cases", () => {
  it("handles empty string reason", () => {
    const result = decodeRejection("");
    assert.ok(result.variant.length > 0);
    assert.ok(result.explanation.length > 0);
  });

  it("handles whitespace-only reason", () => {
    const result = decodeRejection("   ");
    assert.ok(result.explanation.includes("Unknown rejection reason"));
  });
});

describe("decodeRejection numeric codes", () => {
  it("decodes numeric 22 as CapExceeded", () => {
    const result = decodeRejection(22);
    assert.equal(result.variant, "CapExceeded");
    assert.equal(result.policyException?.field, "perTxCap");
  });

  it("decodes numeric 23 as WindowExceeded", () => {
    assert.equal(decodeRejection(23).variant, "WindowExceeded");
  });

  it("decodes numeric 24 as ContractNotAllowed", () => {
    assert.equal(decodeRejection(24).variant, "ContractNotAllowed");
  });

  it("decodes numeric 25 as FunctionNotAllowed", () => {
    assert.equal(decodeRejection(25).variant, "FunctionNotAllowed");
  });

  it("decodes numeric 11 as DMSExpired", () => {
    assert.equal(decodeRejection(11).variant, "DMSExpired");
  });

  it("decodes numeric 10 as GuardFrozen", () => {
    const result = decodeRejection(10);
    assert.equal(result.variant, "GuardFrozen");
    assert.equal(result.policyException, null);
  });

  it("decodes bare numeric strings", () => {
    assert.equal(decodeRejection("22").variant, "CapExceeded");
  });

  it("maps an unknown numeric code to the Unknown fallback, not a real variant", () => {
    const result = decodeRejection(99);
    assert.equal(result.variant, "CapExceeded");
    assert.ok(result.explanation.includes("Unknown rejection reason"));
    assert.equal(result.policyException, null);
  });
});

describe("decodeRejection reason aliases", () => {
  it("maps protocol_not_allowed and asset_not_allowed to ContractNotAllowed", () => {
    assert.equal(decodeRejection("protocol_not_allowed").variant, "ContractNotAllowed");
    assert.equal(decodeRejection("asset_not_allowed").variant, "ContractNotAllowed");
    assert.equal(decodeRejection("unknown_contract").variant, "ContractNotAllowed");
  });

  it("maps unauthorized to FunctionNotAllowed", () => {
    assert.equal(decodeRejection("unauthorized").variant, "FunctionNotAllowed");
  });

  it("maps paused and no_policy to GuardFrozen with no policy exception", () => {
    for (const reason of ["paused", "no_policy"]) {
      const result = decodeRejection(reason);
      assert.equal(result.variant, "GuardFrozen");
      assert.equal(result.policyException, null);
    }
  });

  it("maps outside_active_window to DMSExpired", () => {
    assert.equal(decodeRejection("outside_active_window").variant, "DMSExpired");
  });

  it("decodes diagnostic one-liners carrying the reason plus values", () => {
    const result = decodeRejection("per_tx_cap_exceeded: 5000000000 > 1000000000");
    assert.equal(result.variant, "CapExceeded");
    assert.equal(result.thresholds?.requested, 5000000000n);
    assert.equal(result.thresholds?.cap, 1000000000n);
  });
});

describe("decodeRejection thresholds", () => {
  it("cites specific numeric thresholds with XLM rendering", () => {
    const result = decodeRejection("per_tx_cap_exceeded", {
      requested: 5000000000n,
      cap: 1000000000n,
    });
    assert.ok(result.explanation.includes("5000000000"));
    assert.ok(result.explanation.includes("1000000000"));
    assert.equal(result.thresholds?.requested, 5000000000n);
    assert.equal(result.thresholds?.cap, 1000000000n);
    assert.equal(result.policyException?.value, "5000000000");
  });

  it("cites the destination contract for ContractNotAllowed", () => {
    const contract = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
    const result = decodeRejection("recipient_not_allowed", { contract });
    assert.ok(result.explanation.includes(contract));
    assert.equal(result.policyException?.value, contract);
  });

  it("pre-populates the protocol exception with contract:function", () => {
    const result = decodeRejection("function_not_allowed", {
      contract: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      function: "swap",
    });
    assert.equal(result.variant, "FunctionNotAllowed");
    assert.ok((result.policyException?.value ?? "").includes("swap"));
  });
});

describe("decodeRejectionFromDiagnostics", () => {
  const diagnosticError = {
    event: {
      body: {
        v0: {
          topics: [{ symbol: "error" }, { symbol: "per_tx_cap_exceeded" }],
          data: "5000000000 exceeds cap 1000000000",
        },
      },
    },
  };

  it("decodes the guard reason out of diagnostic events", () => {
    const result = decodeRejectionFromDiagnostics([diagnosticError]);
    assert.ok(result !== null);
    assert.equal(result.variant, "CapExceeded");
    assert.ok(result.diagnostics.length > 0);
  });

  it("parses the authorization call tree with parameter values", () => {
    const events = [
      {
        fn_call: "swap",
        contract: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
        args: { amount: "5000000000" },
      },
    ];
    const calls = parseAuthCallTree(events);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.contract, "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
    assert.equal(calls[0]?.function, "swap");
    assert.ok((calls[0]?.args ?? "").includes("5000000000"));
  });

  it("bounds diagnostic summaries so they cannot flood the UI", () => {
    const lines = diagnosticSummaries([{ data: "x".repeat(5000) }]);
    assert.equal(lines.length, 1);
    assert.ok((lines[0] ?? "").length < 400);
  });

  it("returns null for empty diagnostics with no fallback (explicit failure, not a guess)", () => {
    assert.strictEqual(decodeRejectionFromDiagnostics([], null), null);
    assert.strictEqual(decodeRejectionFromDiagnostics(null), null);
  });

  it("returns null for diagnostics with no recognisable guard reason", () => {
    const noise = { event: { body: { v0: { topics: [{ symbol: "fn_call" }], data: "void" } } } };
    assert.strictEqual(decodeRejectionFromDiagnostics([noise]), null);
  });

  it("honours a fallback reason when diagnostics carry no reason", () => {
    const noise = { note: "nothing useful" };
    const result = decodeRejectionFromDiagnostics([noise], "window_cap_exceeded");
    assert.equal(result?.variant, "WindowExceeded");
  });
});
