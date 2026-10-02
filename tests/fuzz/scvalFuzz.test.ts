/**
 * Property-based fuzzing for the guard's parsers and ScVal decoders.
 *
 * The dashboard parses operator-typed strings and decodes values that arrive
 * from a chain it does not control. Neither source can be trusted, and a single
 * unhandled exception in either layer takes down an operator screen at the worst
 * possible moment — while they are about to sign a policy. The properties here
 * assert the contract those modules promise: they either return a valid value or
 * a *structured* failure, and they never throw an unhandled exception.
 *
 * `fast-check` explores thousands of inputs per property, including arbitrary
 * Unicode, extreme BigInt magnitudes, and mutated XDR byte arrays. Unlike the
 * example-based unit tests, this suite is what finds the input nobody thought to
 * write down.
 *
 * Scope note: the issue that tracks this suite names `decodePolicy` and
 * `decodeEvent`. Neither exists in `lib/guard` (or in the SDK) at the time of
 * writing, so this file fuzzes the decoders the codebase actually ships:
 * `parseAmount` (reached through `validateInitParameters`), the stroop
 * formatters, `buildPolicyConfig`, the XDR/`scValToNative` boundary, and the
 * SDK's `decodeCheckResult` / `decodeAuthDecision` /
 * `guardEventsFromDiagnostics`. Adding the two named decoders is tracked
 * separately rather than smuggled into a test-only change.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  decodeAuthDecision,
  decodeCheckResult,
  guardEventsFromDiagnostics,
} from "stellar-agent-guard-sdk";
import { validateInitParameters } from "../../lib/guard/initValidator.ts";
import {
  formatRawStroops,
  formatStroops,
  formatStroopsWithUnit,
} from "../../lib/guard/formatters.ts";
import { EMPTY_DRAFT, buildPolicyConfig, type PolicyDraft } from "../../lib/guard/policyForm.ts";
import { hexToBytes } from "../../lib/guard/scval.ts";

/** The issue requires at least 1,000 iterations per property. */
const NUM_RUNS = 1_000;

/** A known-good contract address, used so fuzzed drafts can also be *valid*. */
const CONTRACT = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
/** A known-good account address. */
const ACCOUNT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

/** Arbitrary text, weighted toward the malformed and the non-ASCII. */
const text = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.string({ unit: "grapheme", maxLength: 32 }),
    fc.string({ unit: "binary", maxLength: 32 }),
    fc.constantFrom(
      "",
      " ",
      "0",
      "  42  ",
      "-1",
      "1.5",
      "1,000",
      "0x10",
      "9".repeat(60),
      ACCOUNT,
      CONTRACT,
      "not-an-address",
      "🚀💥",
      "\u0000\u001f",
    ),
  );

/** Decimal-ish strings, including values far beyond a JS `number`. */
const numericString = (): fc.Arbitrary<string> =>
  fc.oneof(
    text(),
    fc.nat({ max: 1_000_000_000 }).map(String),
    fc.bigInt({ min: 0n, max: 10n ** 40n }).map(String),
    fc.constantFrom("170141183460469231731687303715884105727", "99999999999999999999"),
  );

/** Zero or more "lines" that look like the address-list fields of the policy form. */
const addressLines = (): fc.Arbitrary<string> =>
  fc
    .array(fc.oneof(text(), fc.constantFrom(CONTRACT, ACCOUNT)), { maxLength: 3 })
    .map((lines) => lines.join("\n"));

const draftArbitrary: fc.Arbitrary<PolicyDraft> = fc.record({
  perTxCap: numericString(),
  windowCap: numericString(),
  windowSecs: numericString(),
  assets: addressLines(),
  assetCaps: fc.array(
    fc.record({
      assetContractAddress: text(),
      maxCapStroops: numericString(),
      symbol: text(),
    }),
    { maxLength: 2 },
  ),
  recipients: addressLines(),
  allowAnyRecipient: fc.boolean(),
  protocols: fc
    .array(
      fc.oneof(text(), fc.constantFrom(CONTRACT, `${CONTRACT}:swap,deposit`, `${CONTRACT}:`)),
      { maxLength: 3 },
    )
    .map((lines) => lines.join("\n")),
  activeFrom: numericString(),
  activeUntil: numericString(),
  paused: fc.boolean(),
  dmsGraceSecs: numericString(),
});

test("amount parsing via validateInitParameters always returns a structured result", () => {
  fc.assert(
    fc.property(
      fc.record({
        adminAddress: text(),
        agentAddress: text(),
        dmsDurationSecs: numericString(),
        perTxCap: numericString(),
        windowCap: numericString(),
      }),
      (params) => {
        // `parseAmount` is module-private and reached only through this public
        // validator, so fuzzing the validator is how the parser is exercised.
        // The point is that no arbitrary string can make it throw: every field
        // becomes either a valid BigInt or an explicit failing check.
        const result = validateInitParameters(params);
        assert.ok(Array.isArray(result.checks));
        assert.equal(typeof result.canDeploy, "boolean");
        for (const check of result.checks) {
          assert.equal(typeof check.passed, "boolean");
          assert.equal(check.fatal, true);
          assert.ok(check.detail.length > 0, "every check must explain itself");
        }
        assert.ok(result.blockers.every((blocker) => !blocker.passed));
        assert.equal(result.canDeploy, result.blockers.length === 0);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("valid arbitrary-magnitude caps parse to exact BigInts", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 2n ** 100n }),
      fc.bigInt({ min: 0n, max: 2n ** 100n }),
      (perTx, extra) => {
        // A window cap at or above the per-tx cap is the only way the cap checks
        // can all pass, so a passing result proves the parser recovered the
        // exact magnitudes — including values no `number` can hold.
        const windowCap = perTx + extra;
        const result = validateInitParameters({
          adminAddress: ACCOUNT,
          agentAddress: ACCOUNT,
          dmsDurationSecs: "300",
          perTxCap: perTx.toString(),
          windowCap: windowCap.toString(),
        });
        // Only separation-of-duties fails, because both addresses are the same.
        assert.deepEqual(
          result.blockers.map((blocker) => blocker.id),
          ["separation-of-duties"],
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("stroop formatters never throw for a non-negative BigInt", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.bigInt({ min: 0n, max: 2n ** 200n }),
        fc.nat({ max: 1_000_000_000 }),
        fc.nat({ max: 1_000_000_000 }).map(String),
      ),
      (value) => {
        const human = formatStroops(value);
        const withUnit = formatStroopsWithUnit(value, { symbol: "TKN", decimals: 7 });
        const raw = formatRawStroops(value);
        assert.equal(typeof human, "string");
        assert.equal(withUnit, `${human} TKN`);
        assert.ok(raw.endsWith(" stroops"));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("stroop formatters reject unusable input with a structured RangeError only", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string({ unit: "grapheme" }), fc.double(), fc.constant(-1n)),
      (value) => {
        for (const format of [formatStroops, formatRawStroops, formatStroopsWithUnit]) {
          try {
            format(value as never);
          } catch (error) {
            assert.ok(
              error instanceof RangeError,
              `expected a structured RangeError, got ${String(error)}`,
            );
          }
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("buildPolicyConfig never throws anything but a structured RangeError", () => {
  fc.assert(
    fc.property(draftArbitrary, (draft) => {
      let result;
      try {
        result = buildPolicyConfig(draft);
      } catch (error) {
        // The SDK's encoders reject caps outside the i128/u64 domain with a
        // RangeError. That is a structured, recoverable rejection — the property
        // is that no *unexpected* exception (TypeError, etc.) can escape.
        assert.ok(
          error instanceof RangeError,
          `unexpected error type from buildPolicyConfig: ${String(error)}`,
        );
        return;
      }
      if (result.ok) {
        assert.equal(typeof result.config.per_tx_cap, "bigint");
        assert.ok(result.scval instanceof xdr.ScVal);
      } else {
        assert.ok(result.issues.length > 0, "a rejected draft must name at least one issue");
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildPolicyConfig accepts a fully valid draft of random magnitudes", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 2n ** 100n }),
      fc.bigInt({ min: 0n, max: 2n ** 100n }),
      fc.bigInt({ min: 1n, max: 2n ** 40n }),
      (perTx, extra, windowSecs) => {
        const draft: PolicyDraft = {
          ...EMPTY_DRAFT,
          perTxCap: perTx.toString(),
          windowCap: (perTx + extra).toString(),
          windowSecs: windowSecs.toString(),
          assets: CONTRACT,
          allowAnyRecipient: true,
        };
        const result = buildPolicyConfig(draft);
        assert.equal(result.ok, true, "a structurally valid draft must build");
        if (result.ok) {
          assert.equal(result.config.per_tx_cap, perTx);
          assert.equal(result.config.window_secs, windowSecs);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("hexToBytes round-trips even-length input and rejects odd-length input", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 64 }), (value) => {
      const clean = value.replace(/^0x/, "");
      if (clean.length % 2 !== 0) {
        assert.throws(() => hexToBytes(value), Error);
        return;
      }
      const bytes = hexToBytes(value);
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(bytes.length, clean.length / 2);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("arbitrary bytes at the ScVal boundary decode or fail, never crash", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      let scval: xdr.ScVal;
      try {
        scval = xdr.ScVal.fromXDR(bytes);
      } catch (error) {
        assert.ok(error instanceof Error, "a malformed ScVal must raise an Error");
        return;
      }
      // Some byte strings are valid XDR yet not convertible to a native value;
      // that must also surface as a normal Error rather than a crash.
      try {
        scValToNative(scval);
      } catch (error) {
        assert.ok(error instanceof Error, "a non-native ScVal must raise an Error");
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

test("mutated valid XDR is safely rejected or safely decoded", () => {
  // `lib/guard/scval.ts` no longer wraps this: build the i128 ScVal the same
  // way the removed helper did, straight from the SDK.
  const base = new Uint8Array(nativeToScVal(42n, { type: "i128" }).toXDR());
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: base.length - 1 }),
      fc.integer({ min: 0, max: 255 }),
      (index, byte) => {
        const mutated = new Uint8Array(base);
        mutated[index] = byte;
        let scval: xdr.ScVal;
        try {
          scval = xdr.ScVal.fromXDR(mutated);
        } catch (error) {
          assert.ok(error instanceof Error);
          return;
        }
        try {
          scValToNative(scval);
        } catch (error) {
          assert.ok(error instanceof Error);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("decodeCheckResult returns a valid CheckResult or throws an Error", () => {
  fc.assert(
    fc.property(fc.anything(), (raw) => {
      let result;
      try {
        result = decodeCheckResult(raw);
      } catch (error) {
        assert.ok(error instanceof Error);
        return;
      }
      assert.ok(result.kind === "allowed" || result.kind === "blocked");
      if (result.kind === "blocked") assert.equal(typeof result.reason, "string");
    }),
    { numRuns: NUM_RUNS },
  );
});

test("decodeAuthDecision returns null or a well-formed decision, never throws", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ unit: "grapheme", maxLength: 24 }), { maxLength: 4 }),
      fc.constantFrom<"ledger" | "diagnostic">("ledger", "diagnostic"),
      (topics, source) => {
        const decision = decodeAuthDecision(topics, source);
        if (decision === null) return;
        assert.ok(decision.result === "allowed" || decision.result === "blocked");
        assert.equal(decision.source, source);
        assert.ok(decision.reason === null || typeof decision.reason === "string");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("guardEventsFromDiagnostics safely ignores arbitrary event objects", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          event: fc.anything(),
          body: fc.anything(),
          value: fc.anything(),
          topics: fc.anything(),
        }),
        { maxLength: 4 },
      ),
      (events) => {
        const decoded = guardEventsFromDiagnostics(events, CONTRACT);
        assert.ok(Array.isArray(decoded));
        for (const event of decoded) {
          assert.equal(typeof event.topic, "string");
          assert.ok(event.source === "diagnostic");
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});
