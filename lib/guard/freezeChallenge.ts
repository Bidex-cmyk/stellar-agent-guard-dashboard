/**
 * Escalated freeze confirmation for large exposures (issue #15).
 *
 * PanicPanel's two-step confirm (checkbox → Sign freeze) is right for small
 * accounts: an accidental freeze costs a short manual unfreeze and nothing
 * else, and the emergency path should stay fast. For an account holding real
 * value the same two clicks are also what an operator under no-incident
 * conditions trains on — click through the dialog enough times and the dialog
 * stops protecting the one time it mattered. So above a threshold the confirm
 * step upgrades from "click Yes" to a prefix-challenge: type the last 6
 * characters of the guard address. Deliberate friction, the same pattern
 * destructive infra tooling uses — and friction that only exists where the
 * stakes justify it.
 *
 * Balance source for the threshold: `readNativeXlmBalance(server, guard)` in
 * `lib/guard/chain.ts` — a live XLM read from Soroban RPC (the guard's native
 * SAC `Balance` ledger entry), never a cached or derived number. That reader
 * returns `ReadResult<bigint>`; this module's `null` input is the caller's
 * translation of anything that is not a successful read (RPC error, demo mode,
 * read still in flight). The rule on `null` is fail-safe: uncertainty escalates
 * friction, never reduces it, so unknown balance → challenge shown.
 *
 * Pure and React-free for the usual reason: the boundary comparison is the
 * part worth pinning, and a test must be able to assert both sides of it
 * without mounting a component (`tests/unit/freezeChallenge.test.ts`).
 */

/** Stroops in one XLM — the base unit every chain balance is denominated in. */
const STROOPS_PER_XLM = 10_000_000n;

/**
 * XLM balance at or above which the freeze confirm requires the typed
 * challenge. Proposed at 10,000 XLM for the maintainer to tune: below it an
 * accidental freeze costs one manual unfreeze and nothing more, so the
 * standard two-step keeps the emergency path fast; at/above it the account
 * carries enough value that five seconds of deliberate typing is clearly
 * cheaper than a habit-clicked freeze — and, just as important, operators
 * who freeze small accounts by habit never get trained to click through the
 * dialog that guards the large ones.
 *
 * Expressed as a string so the value survives exactly (no float), and derived
 * to stroops once here so every caller compares in the unit the chain reports.
 */
export const FREEZE_CHALLENGE_THRESHOLD_XLM = "10000";

/** The threshold in stroops: 10,000 XLM = 100,000,000,000 stroops. */
export const FREEZE_CHALLENGE_THRESHOLD_STROOPS =
  BigInt(FREEZE_CHALLENGE_THRESHOLD_XLM) * STROOPS_PER_XLM;

/** How many trailing characters of the guard address the operator must type. */
export const FREEZE_CHALLENGE_SUFFIX_LENGTH = 6;

/**
 * Does this freeze need the typed challenge?
 *
 * Comparison is pinned here and asserted on both sides in
 * `tests/unit/freezeChallenge.test.ts`: **`balance >= threshold`, inclusive**
 * — a balance exactly at the threshold is "large exposure" and is challenged;
 * one stroop below is not.
 *
 * `null` means "no successful live balance read" (RPC error, demo mode, read
 * still in flight) and returns `true` on purpose: when the stakes are
 * unknown the friction goes up, never down.
 */
export function requiresFreezeChallenge(balanceStroops: bigint | null): boolean {
  if (balanceStroops === null) return true;
  return balanceStroops >= FREEZE_CHALLENGE_THRESHOLD_STROOPS;
}

/**
 * The string the operator must type: the trailing characters of the guard
 * address, which the dialog also shows in full — this is friction against a
 * mis-click, not a secret (see the dialog copy for the threat-honest wording).
 */
export function freezeChallengeSuffix(guard: string): string {
  return guard.trim().slice(-FREEZE_CHALLENGE_SUFFIX_LENGTH);
}

/**
 * Does the typed input match the guard's suffix?
 *
 * Exact match after trimming: a StrKey address is case-sensitive, so a
 * lower-cased variant is a different string and reads as a mismatch rather
 * than being quietly normalised. Empty input never matches.
 */
export function freezeChallengeMatches(input: string, guard: string): boolean {
  const suffix = freezeChallengeSuffix(guard);
  if (suffix.length === 0) return false;
  return input.trim() === suffix;
}
