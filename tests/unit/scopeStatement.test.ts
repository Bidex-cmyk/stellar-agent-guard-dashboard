import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ENFORCEMENT_SCOPE_STATEMENT } from "../../lib/guard/network.ts";

/**
 * The exact wording this project is required to use for the enforcement boundary.
 *
 * Duplicated here deliberately: this test is the drift guard. If the statement is
 * reworded in the constant, in the README or in SPEC.md, this fails — which is the
 * point, because the failure mode this guards against is a capability claim
 * quietly outgrowing what the contract enforces.
 */
const REQUIRED =
  "Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is " +
  "native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are " +
  "the calls whose arguments the Soroban auth context exposes for inspection. For other " +
  "Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), " +
  "the policy engine still enforces window and pause state, but per-call amount/recipient " +
  "limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is " +
  "tracked as a v2 item, not implied as already covered.";

test("the canonical statement is the required framing, word for word", () => {
  assert.equal(ENFORCEMENT_SCOPE_STATEMENT, REQUIRED);
});

test("the statement carries both halves of the boundary", () => {
  // The capability half and the limitation half must be in the same statement: a
  // version that kept only the first would be the overclaim this guards against.
  assert.match(ENFORCEMENT_SCOPE_STATEMENT, /full recipient\/amount enforcement/i);
  assert.match(ENFORCEMENT_SCOPE_STATEMENT, /not yet enforced/);
  assert.match(ENFORCEMENT_SCOPE_STATEMENT, /v2 item/);
});

test("the statement does not overclaim arbitrary calls", () => {
  assert.doesNotMatch(ENFORCEMENT_SCOPE_STATEMENT, /any Soroban call/i);
  assert.doesNotMatch(ENFORCEMENT_SCOPE_STATEMENT, /all contract interactions/i);
  assert.doesNotMatch(ENFORCEMENT_SCOPE_STATEMENT, /every contract call is enforced/i);
});

test("README and SPEC.md carry the same statement as the code", () => {
  // The requirement is not only that the boundary is stated, but that the
  // documents and the interface state it identically. The documents wrap the text
  // across lines and may emphasis it, so the comparison normalises whitespace and
  // strips markdown emphasis markers — but keeps backticks, because the code
  // spans around `transfer`/`transfer_from` are part of the required wording.
  const normalise = (text: string): string => text.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  const wanted = normalise(REQUIRED);

  for (const path of ["README.md", "SPEC.md"]) {
    const content = normalise(readFileSync(path, "utf8"));
    assert.ok(
      content.includes(wanted),
      `${path} must contain the required enforcement-scope statement verbatim`,
    );
  }
});
