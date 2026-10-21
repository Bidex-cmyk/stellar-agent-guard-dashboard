/**
 * Deployment and configuration drafts (issue #20).
 *
 * The deploy and configure flows are multi-step; a refresh or a closed tab
 * used to lose every entered value — the salt the operator typed, the agent
 * address, the caps they were about to sign. This module persists those
 * half-finished forms in `localStorage` and restores them on the next mount,
 * with two properties the rest of the console depends on:
 *
 *   - **Zero secrets, by construction.** The only shapes that can be written
 *     are `PolicyDraft` and `DeployDraft`, whose fields are addresses, public
 *     keys and numeric parameters, all as plain strings. `POLICY_DRAFT_FIELDS`
 *     and `DEPLOY_DRAFT_FIELDS` are the closed lists `tests/unit/drafts.test.ts`
 *     audits the raw stored JSON against — the same discipline as
 *     `SETUP_STORED_KEYS` in `setupChecklist.ts` — so a future edit that starts
 *     persisting a secret-adjacent field fails the audit rather than shipping.
 *     A draft that cannot be shaped into one of those two records is discarded
 *     whole on read; nothing unknown survives a round-trip.
 *
 *   - **Scoped per network + guard address**, through `guardScoped.ts`, so a
 *     mainnet draft never restores over a testnet form and a draft edited for
 *     guard A never appears on guard B's form. The deploy draft has no guard
 *     address yet (the address is what the deploy computes), so it is scoped
 *     to a reserved `"(new)"` slot per network instead.
 *
 * Drafts older than `DRAFT_TTL_DAYS` are ignored *and purged* on read: a
 * weeks-old half-configured policy is stale operator intent, and silently
 * resurrecting it would be worse than losing it. Time is injectable (`now`)
 * so the expiry boundary is unit-testable without wall-clock sleeps; the
 * console passes `Date.now` and a future SDK-clock unification can swap that
 * for the shared `Clock` seam noted in the org CONTRIBUTING.
 */

import { clearScopedValue, loadScopedValue, saveScopedValue } from "./guardScoped.ts";
import type { StorageLike } from "./instance.ts";
import { EMPTY_DRAFT, type PolicyDraft } from "./policyForm.ts";
import type { SaltEncoding } from "./saltGenerator.ts";

// ── Envelope and expiry ───────────────────────────────────────────────────

/**
 * A draft older than this is dropped on read, with its storage entry purged.
 *
 * Seven days: long enough to survive a weekend of deliberate deliberation
 * about a policy change, short enough that a draft cannot masquerade as a
 * reviewed plan weeks later. Every stored draft carries its save timestamp,
 * so the threshold moves without a key-version bump.
 */
export const DRAFT_TTL_DAYS = 7;

/** The TTL in milliseconds — the one arithmetic use of the day count. */
export const DRAFT_TTL_MS = DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Quiet time after the last edit before a form's draft is written.
 *
 * The same shape as `HISTORY_DEBOUNCE_MS` in `useHistoryState.ts`: typing a
 * cap digit-by-digit should produce one storage write when the burst settles,
 * not one per keystroke.
 */
export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * What is written to storage: the draft plus when it was saved.
 *
 * `savedAt` is epoch milliseconds, matching `Date.now()` and the SDK clock's
 * unit, so expiry compares like with like.
 */
export interface DraftEnvelope<T> {
  v: 1;
  savedAt: number;
  draft: T;
}

/** A draft that survived restore, with its age available to the banner. */
export interface RestoredDraft<T> {
  draft: T;
  savedAt: number;
}

/** Injectable seams: the storage bucket and the clock, both optional. */
export interface DraftOptions {
  storage?: StorageLike | null;
  /** Returns epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

// ── The two draft shapes (the zero-secrets audit surface) ─────────────────

/**
 * Exactly the fields persisted for a configure-form draft.
 *
 * Every field is a string or boolean the operator typed into the policy form
 * (`PolicyDraft`); `assetCaps` rows are three strings each. Nothing here is,
 * or can reconstruct, a secret key — the wallet holds those and this console
 * never sees them.
 */
export const POLICY_DRAFT_FIELDS = [
  "perTxCap",
  "windowCap",
  "windowSecs",
  "assets",
  "assetCaps",
  "recipients",
  "allowAnyRecipient",
  "protocols",
  "activeFrom",
  "activeUntil",
  "paused",
  "dmsGraceSecs",
] as const;

/**
 * Exactly the fields persisted for a deploy-panel draft.
 *
 * `saltHex` is the 32-byte deploy salt as hex — the input the predicted
 * address is derived from, never a signing key. `agentPubkeyHex` is the raw
 * Ed25519 *public* key the agent signs with (the panel's own hint says so);
 * the agent's secret never enters this console, let alone storage. Caps and
 * grace are plain numeric strings.
 */
export const DEPLOY_DRAFT_FIELDS = [
  "saltHex",
  "saltEncoding",
  "saltText",
  "agentPubkeyHex",
  "agentAddress",
  "dmsDurationSecs",
  "perTxCap",
  "windowCap",
] as const;

/** The deploy-panel form state worth remembering between mounts. */
export interface DeployDraft {
  /** The deploy salt as 64 hex characters, or empty when only text was typed. */
  saltHex: string;
  saltEncoding: SaltEncoding;
  /** The salt as the operator typed it, so the text box refills as typed. */
  saltText: string;
  /** Raw Ed25519 *public* key hex the agent signs with — not a secret. */
  agentPubkeyHex: string;
  /** The agent's G… account address. */
  agentAddress: string;
  dmsDurationSecs: string;
  perTxCap: string;
  windowCap: string;
}

// ── Scoped key bases ──────────────────────────────────────────────────────

/**
 * The `guardScoped` base for configure-form drafts. Already reserved in
 * `SCOPED_STORAGE_BASES`, so deleting a guard cascades its draft away.
 */
export const POLICY_DRAFT_BASE = "policyDraft";

/**
 * The `guardScoped` base for deploy-panel drafts. Scoped to the reserved
 * `DEPLOY_DRAFT_SLOT` below rather than a guard address: at deploy time the
 * guard address is exactly what does not exist yet.
 *
 * Deliberately *not* added to `SCOPED_STORAGE_BASES`: the delete cascade is
 * per-guard, and this slot is not a guard — clearing it on instance removal
 * would destroy an in-progress deploy form for a *different*, future guard.
 */
export const DEPLOY_DRAFT_BASE = "deployDraft";

/**
 * The per-network slot deploy drafts live in, standing in for the guard
 * address the deploy has not produced yet.
 */
export const DEPLOY_DRAFT_SLOT = "(new)";

// ── Sanitizers — the only shapes that ever round-trip ─────────────────────

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * Coerce unknown stored data into a `PolicyDraft` with exactly
 * `POLICY_DRAFT_FIELDS`, or return `null` when it is not an object at all.
 *
 * Unknown keys are dropped rather than copied — that is the zero-secrets
 * guarantee at the read edge, mirroring `sanitizeEntry` in `setupChecklist.ts`.
 */
export function sanitizePolicyDraft(raw: unknown): PolicyDraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const assetCapsRaw = Array.isArray(record.assetCaps) ? record.assetCaps : [];
  return {
    perTxCap: asString(record.perTxCap),
    windowCap: asString(record.windowCap),
    windowSecs: asString(record.windowSecs) || EMPTY_DRAFT.windowSecs,
    assets: asString(record.assets),
    assetCaps: assetCapsRaw
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      .map((row) => ({
        assetContractAddress: asString(row.assetContractAddress),
        maxCapStroops: asString(row.maxCapStroops),
        symbol: asString(row.symbol),
      })),
    recipients: asString(record.recipients),
    allowAnyRecipient: asBoolean(record.allowAnyRecipient),
    protocols: asString(record.protocols),
    activeFrom: asString(record.activeFrom),
    activeUntil: asString(record.activeUntil),
    paused: asBoolean(record.paused),
    dmsGraceSecs: asString(record.dmsGraceSecs),
  };
}

/** The `deployDraft` counterpart of `sanitizePolicyDraft`. */
export function sanitizeDeployDraft(raw: unknown): DeployDraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const encoding = record.saltEncoding === "utf8" ? "utf8" : "hex";
  return {
    saltHex: asString(record.saltHex),
    saltEncoding: encoding,
    saltText: asString(record.saltText),
    agentPubkeyHex: asString(record.agentPubkeyHex),
    agentAddress: asString(record.agentAddress),
    dmsDurationSecs: asString(record.dmsDurationSecs),
    perTxCap: asString(record.perTxCap),
    windowCap: asString(record.windowCap),
  };
}

// ── Core save / load / clear ──────────────────────────────────────────────

/**
 * Persist a draft under its scoped key.
 *
 * The write is best-effort (private-mode quota failures stay silent, as
 * everywhere else in this repo) and the envelope's `savedAt` comes from the
 * injected clock so tests control expiry.
 */
export function saveDraft<T>(
  base: string,
  network: string,
  scope: string,
  draft: T,
  options?: DraftOptions,
): void {
  const now = options?.now ?? Date.now;
  const envelope: DraftEnvelope<T> = { v: 1, savedAt: now(), draft };
  const passThrough = options?.storage === undefined ? {} : { storage: options.storage };
  saveScopedValue(base, network, scope, envelope, passThrough);
}

/**
 * Read a draft back, or `null` when there is none, it is corrupt, it does not
 * sanitize into the expected shape, or it has expired.
 *
 * An expired draft is *purged* here — not merely ignored — so the next mount
 * does not re-evaluate it and the storage bucket does not accumulate ghosts.
 */
export function loadDraft<T>(
  base: string,
  network: string,
  scope: string,
  sanitize: (raw: unknown) => T | null,
  options?: DraftOptions,
): RestoredDraft<T> | null {
  // `undefined` storage resolves to the browser default inside the scoped
  // helpers; an explicit `null` means "no storage" (SSR / tests).
  const passThrough = options?.storage === undefined ? {} : { storage: options.storage };
  const raw: unknown = loadScopedValue<unknown>(base, network, scope, passThrough);
  if (raw === null) return null;

  const envelope = raw as Partial<DraftEnvelope<unknown>> | null;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    typeof envelope.savedAt !== "number" ||
    !Number.isFinite(envelope.savedAt)
  ) {
    clearScopedValue(base, network, scope, passThrough);
    return null;
  }

  const now = (options?.now ?? Date.now)();
  if (now - envelope.savedAt > DRAFT_TTL_MS) {
    clearScopedValue(base, network, scope, passThrough);
    return null;
  }

  const draft = sanitize(envelope.draft);
  if (draft === null) {
    clearScopedValue(base, network, scope, passThrough);
    return null;
  }
  return { draft, savedAt: envelope.savedAt };
}

/** Forget a draft. Idempotent; a missing key is not an error. */
export function clearDraft(
  base: string,
  network: string,
  scope: string,
  options?: DraftOptions,
): void {
  const passThrough = options?.storage === undefined ? {} : { storage: options.storage };
  clearScopedValue(base, network, scope, passThrough);
}

// ── Typed façades for the two panels ──────────────────────────────────────

/** Save a configure-form draft for one guard on one network. */
export function savePolicyDraft(
  network: string,
  guard: string,
  draft: PolicyDraft,
  options?: DraftOptions,
): void {
  saveDraft(POLICY_DRAFT_BASE, network, guard, draft, options);
}

/**
 * Restore the configure-form draft for one guard on one network, or `null`.
 *
 * `network` and `guard` come from the caller (the panel's active selection),
 * never from the stored value — the key is the authority, so a draft can only
 * ever restore onto the exact form it was saved from.
 */
export function loadPolicyDraft(
  network: string,
  guard: string,
  options?: DraftOptions,
): RestoredDraft<PolicyDraft> | null {
  return loadDraft(POLICY_DRAFT_BASE, network, guard, sanitizePolicyDraft, options);
}

/** Forget the configure-form draft for one guard on one network. */
export function clearPolicyDraft(network: string, guard: string, options?: DraftOptions): void {
  clearDraft(POLICY_DRAFT_BASE, network, guard, options);
}

/** Save the deploy-panel draft for one network's pre-deploy slot. */
export function saveDeployDraft(network: string, draft: DeployDraft, options?: DraftOptions): void {
  saveDraft(DEPLOY_DRAFT_BASE, network, DEPLOY_DRAFT_SLOT, draft, options);
}

/** Restore the deploy-panel draft for one network, or `null`. */
export function loadDeployDraft(
  network: string,
  options?: DraftOptions,
): RestoredDraft<DeployDraft> | null {
  return loadDraft(DEPLOY_DRAFT_BASE, network, DEPLOY_DRAFT_SLOT, sanitizeDeployDraft, options);
}

/** Forget the deploy-panel draft for one network. */
export function clearDeployDraft(network: string, options?: DraftOptions): void {
  clearDraft(DEPLOY_DRAFT_BASE, network, DEPLOY_DRAFT_SLOT, options);
}
