/**
 * Which of the three policy states a guard is in, derived from one live read.
 *
 * There are three states, not two, and the third one is the point of this module:
 * `unknown` is what an unreadable `status()` looks like, and it is not the same
 * as `default-deny`. Reading `no policy` off a failed read is how a dashboard
 * ends up claiming a safe state it never read, which SPEC §4's "no
 * default-on-failure" rule forbids.
 *
 * Nothing here caches: the answer is a pure function of the `ReadResult` the
 * snapshot carries, so it changes the moment a re-read returns a different
 * value. A revoke performed in another tab, or by the operator's own agent, is
 * therefore reflected by the next poll with no local flag to keep in step — the
 * same derived-from-truth discipline the configurator's "Load installed" draft
 * follows.
 */

import type { GuardStatus } from "stellar-agent-guard-sdk";
import type { ReadResult } from "./chain.ts";

/**
 * `unknown` — `status()` has not been read, or the read failed.
 * `installed` — a policy is in force.
 * `default-deny` — no policy is stored, so every call is refused (`no_policy`).
 */
export type PolicyState = "unknown" | "installed" | "default-deny";

/**
 * The consequence, in the operator's terms, with no euphemism.
 *
 * "Blocked" is the accurate word: with nothing installed the account refuses
 * every call, which is safe but not functional, and an operator who reads a
 * quiet status line will not know that.
 */
export const NO_POLICY_CONSEQUENCE =
  "Guard active, but no policy installed — ALL transactions are blocked until you configure one " +
  "(default-deny). The contract answers `check()` with `no_policy` and refuses every call.";

/** Derive the policy state from a live `status()` read, or from its absence. */
export function policyStateFrom(status: ReadResult<GuardStatus> | null | undefined): PolicyState {
  if (!status || !status.ok) return "unknown";
  return status.value.has_policy ? "installed" : "default-deny";
}
