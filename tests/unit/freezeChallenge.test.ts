/**
 * The freeze-challenge threshold and prefix-challenge rules (issue #15).
 *
 * The boundary comparison is the whole point of this file: `requiresFreezeChallenge`
 * is pinned on both sides — one stroop below the threshold stays on the
 * existing two-step confirm, the threshold itself and everything above it
 * requires the typed challenge, and an unavailable balance fails safe to the
 * challenge. A change to the comparison that these tests do not force is a
 * change to when operators get the friction, so each direction has its own
 * assertion with the chosen comparison (`>=`, inclusive) stated in the name.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FREEZE_CHALLENGE_SUFFIX_LENGTH,
  FREEZE_CHALLENGE_THRESHOLD_STROOPS,
  FREEZE_CHALLENGE_THRESHOLD_XLM,
  freezeChallengeMatches,
  freezeChallengeSuffix,
  requiresFreezeChallenge,
} from "../../lib/guard/freezeChallenge.ts";

/** The pinned Phase 1 guard address — a real 56-character contract `C…` strkey. */
const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const XLM = 10_000_000n;

test("the threshold constant is 10,000 XLM expressed exactly in stroops", () => {
  // No float ever touches this value: it is parsed from the decimal string
  // and scaled by the integer stroop factor.
  assert.equal(FREEZE_CHALLENGE_THRESHOLD_XLM, "10000");
  assert.equal(FREEZE_CHALLENGE_THRESHOLD_STROOPS, 10_000n * XLM);
  assert.equal(FREEZE_CHALLENGE_THRESHOLD_STROOPS, 100_000_000_000n);
});

test("one stroop below the threshold → standard confirm, no challenge", () => {
  assert.equal(requiresFreezeChallenge(FREEZE_CHALLENGE_THRESHOLD_STROOPS - 1n), false);
});

test("a balance far below the threshold → standard confirm, no challenge", () => {
  assert.equal(requiresFreezeChallenge(0n), false);
  assert.equal(requiresFreezeChallenge(9_999n * XLM), false);
});

test("a balance exactly AT the threshold → challenge required (boundary inclusive)", () => {
  // The pinned comparison is `balance >= threshold`: the boundary itself is
  // "large exposure" and gets the friction, it is not a second below-threshold.
  assert.equal(requiresFreezeChallenge(FREEZE_CHALLENGE_THRESHOLD_STROOPS), true);
});

test("a balance above the threshold → challenge required", () => {
  assert.equal(requiresFreezeChallenge(FREEZE_CHALLENGE_THRESHOLD_STROOPS + 1n), true);
  assert.equal(requiresFreezeChallenge(FREEZE_CHALLENGE_THRESHOLD_STROOPS * 25n), true);
});

test("an unavailable balance (null) fails safe to the challenge", () => {
  // `null` is what the panel passes for every non-successful read (RPC error,
  // demo mode, read still in flight): uncertainty escalates friction, it never
  // reduces it.
  assert.equal(requiresFreezeChallenge(null), true);
});

test("the challenge suffix is the last 6 characters of the guard address", () => {
  assert.equal(FREEZE_CHALLENGE_SUFFIX_LENGTH, 6);
  assert.equal(freezeChallengeSuffix(GUARD), GUARD.slice(-6));
  assert.equal(freezeChallengeSuffix(GUARD).length, 6);
});

test("matching accepts exactly the suffix, trimmed — nothing else", () => {
  const suffix = GUARD.slice(-6);
  assert.equal(freezeChallengeMatches(suffix, GUARD), true, "the exact suffix matches");
  assert.equal(
    freezeChallengeMatches(`  ${suffix}  `, GUARD),
    true,
    "surrounding whitespace is trimmed",
  );

  assert.equal(freezeChallengeMatches("", GUARD), false, "empty input never matches");
  assert.equal(
    freezeChallengeMatches("      ", GUARD),
    false,
    "whitespace-only input never matches",
  );
  assert.equal(
    freezeChallengeMatches(`${suffix.slice(0, 5)}`, GUARD),
    false,
    "a short answer is wrong",
  );
  assert.equal(freezeChallengeMatches(`${suffix}X`, GUARD), false, "an extra character is wrong");
  assert.equal(freezeChallengeMatches("ABC123", GUARD), false, "an unrelated string is wrong");
  assert.equal(
    freezeChallengeMatches(suffix.toLowerCase(), GUARD),
    false,
    "case is significant: a StrKey address is case-sensitive, so lower-cased text is a different string",
  );
});
