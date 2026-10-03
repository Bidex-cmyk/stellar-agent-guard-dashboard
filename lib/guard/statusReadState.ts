/**
 * The three phases every async status read moves through, decided in one place.
 *
 *   pending  → a skeleton placeholder that reserves the resolved layout's space
 *   failed   → the read's own error text, never a substitute value
 *   resolved → the value itself
 *
 * The failed branch is deliberately not "zero with a footnote". The README's
 * no-mock-state rule says: "A failed RPC call renders an explicit error — never
 * a silent zero that looks like an empty policy." A skeleton covers the time a
 * read is in flight; an error block covers the time it failed; neither ever
 * invents a number. These decisions are pure so the React components stay thin
 * over them (SPEC §4) and the state machine is testable without a DOM.
 */

import { formatStroopsWithUnit } from "./formatters.ts";
import type { ReadResult } from "./chain.ts";

export type ReadPhase = "pending" | "failed" | "resolved";

/**
 * The class every skeleton placeholder carries.
 *
 * `.skeleton` is sized in `em` (see app/globals.css), so a skeleton inherits
 * exactly the font size of the slot it sits in (`.stat .v` for values,
 * `.stat .n` for notes) and reserves the same height the resolved element
 * will occupy — the class-parity contract that prevents layout shift (#31).
 */
export const SKELETON_CLASS = "skeleton";

/** Phase of a snapshot field read. `null`/`undefined` means the read is still in flight. */
export function readPhase<T>(result: ReadResult<T> | null | undefined): ReadPhase {
  if (result === null || result === undefined) return "pending";
  return result.ok ? "resolved" : "failed";
}

export interface SkeletonSpec {
  /** Skeleton lines to draw: the first sits in the value slot, the rest in the note slot. */
  lines: number;
}

/**
 * How much space a pending stat must reserve, keyed by the label it will show.
 *
 * The point is vertical parity: a pending "Dead-man switch" stat reserves a
 * value line plus its note line, so nothing below it moves when the read
 * resolves. Specs are asserted in tests/unit/skeletonReads.test.ts.
 */
export function skeletonSpecFor(label: string): SkeletonSpec {
  switch (label) {
    case "Admin freeze":
      return { lines: 1 }; // value only, no note
    case "Dead-man switch":
    case "Policy installed":
    case "Last heartbeat":
      return { lines: 2 }; // value + note line
    default:
      return { lines: 2 };
  }
}

/**
 * The labels of the on-chain state grid, in render order.
 *
 * The first-paint skeleton draws one placeholder stat per label so the pending
 * layout has the same shape (same card count, same value/note slots) as the
 * resolved one. Kept beside the specs so component and state cannot drift.
 */
export const INITIAL_GRID_LABELS = [
  "Admin freeze",
  "Dead-man switch",
  "Policy installed",
  "Last heartbeat",
] as const;

/**
 * The balance read's three states as text — the reference decision for the
 * surface the issue calls the zero-flash "heart-attack" surface.
 *
 * A live balance read does not exist on `main` yet (see PR's excluded-surface
 * row), but the text contract is fixed here so whoever adds the read inherits
 * the no-fake-zero behaviour and its tests:
 *
 *   pending  → "Reading balance…" (a placeholder phrase, never "0")
 *   failed   → "Balance unavailable — <error>" (explicit failure, never "0")
 *   resolved → the formatted amount (which may legitimately be "0.0000000 XLM")
 */
export function balanceText(balance: ReadResult<bigint> | null): string {
  if (balance === null) return "Reading balance…";
  if (!balance.ok) return `Balance unavailable — ${balance.error}`;
  return formatStroopsWithUnit(balance.value);
}
