/**
 * How loudly a telemetry row should read, derived from what the feed decoded.
 *
 * During an incident an operator scans this table for blocks, not for text. When
 * every row wears the same weight, a block is only findable by reading each one,
 * so severity is a *class on the row* — cheap to see, and still carried by the
 * words already in the row, never by colour alone.
 *
 * The derivation is O(1) per row and does no string work: `event.decision.result`
 * and `event.source` are decoded fields on the SDK's `GuardEvent`
 * (`stellar-agent-guard-sdk`, `dist/telemetry.d.ts` — `GuardAuthDecision.result` is the
 * `allowed` / `blocked` pair, and `GuardEventSource` is the `ledger` / `diagnostic`
 * stream discriminator). No topic is parsed and no reason string is matched, so a
 * change to the reason vocabulary cannot silently re-tier a row.
 *
 * Tier colours come from the two tokens the rest of the interface already uses
 * (`--danger`, `--warn`; `.pill.danger` / `.pill.warn`) — the same warning tier the
 * default-deny banner uses (issue #25).
 */

import type { GuardEvent } from "stellar-agent-guard-sdk";

/**
 * `blocked` — the guard refused the call. High contrast: this is the row an
 *   operator is looking for.
 * `allowed` — the guard authorized the call. Neutral: routine, and it should not
 *   compete with a block.
 * `diagnostic` — a row from the refused-simulation stream carrying no decision of
 *   its own; distinguished from committed history because it was never broadcast.
 * `lifecycle` — an admin/heartbeat event from the committed stream: no decision
 *   was made, so it is neither an allow nor a block.
 */
export type FeedSeverity = "blocked" | "allowed" | "diagnostic" | "lifecycle";

/**
 * Severity from decoded fields only.
 *
 * A blocked decision can only arrive as a diagnostic (a refusal rolls its event
 * back), so the decision is checked first: a row that says "blocked" is a block
 * whichever stream carried it.
 */
export function severityFor(event: GuardEvent): FeedSeverity {
  const result = event.decision?.result;
  if (result === "blocked") return "blocked";
  if (result === "allowed") return "allowed";
  return event.source === "diagnostic" ? "diagnostic" : "lifecycle";
}

/** What the severity means in words, for documentation and for tests to pin. */
export const SEVERITY_TIER: Record<FeedSeverity, "danger" | "warn" | "neutral"> = {
  blocked: "danger",
  allowed: "neutral",
  diagnostic: "warn",
  lifecycle: "neutral",
};
