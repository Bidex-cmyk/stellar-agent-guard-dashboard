/**
 * Vetted policy presets: a small set of security archetypes an operator can
 * start from instead of guessing what safe caps and allowlists look like.
 *
 * A preset is a complete {@link PolicyConfig} — the exact shape `set_policy`
 * takes — not a partial template. That matters: every field is always set, so a
 * preset cannot accidentally inherit a looser value from whatever draft happened
 * to be on screen, and the preset can be validated against the same rules the
 * contract applies to a real install.
 *
 * The addresses below are deliberately obvious **placeholders**. A preset is a
 * shape, not a destination: shipping a real recipient or protocol address in an
 * archetype would hand an unknown address a standing authorization. The operator
 * replaces them with their own addresses before installing.
 */

import type { PolicyConfig } from "stellar-agent-guard-sdk";
import { draftFromConfig, type PolicyDraft } from "./policyForm.ts";

/** How much a preset gives away if the agent runtime is compromised. */
export type SecurityProfile = "conservative" | "balanced" | "permissive";

export interface SecurityProfileMeta {
  /** Human-readable badge text. */
  label: string;
  /** The `.pill` modifier the badge renders with, matching the audit palette. */
  pillClass: "ok" | "warn" | "danger";
  /** One line explaining what the profile trades away. */
  description: string;
}

/**
 * The three profiles, ordered from least to most permissive. The label and pill
 * colour are shared by the badge in the form and by the preset explanations, so
 * the visual language stays consistent wherever a profile is shown.
 */
export const SECURITY_PROFILES: Record<SecurityProfile, SecurityProfileMeta> = {
  conservative: {
    label: "Conservative",
    pillClass: "ok",
    description:
      "Tight caps and a strict recipient allowlist. Safest default for an untrusted, experimental, or newly deployed agent.",
  },
  balanced: {
    label: "Balanced",
    pillClass: "warn",
    description:
      "Moderate caps with a protocol allowlist. A reasonable default for a steady production agent with someone watching it.",
  },
  permissive: {
    label: "Permissive",
    pillClass: "danger",
    description:
      "Large caps for high-throughput strategies. Raises the blast radius if the agent or its key is compromised.",
  },
};

export interface PolicyPreset {
  /** Stable slug, safe to use as a `<select>` value. */
  id: string;
  name: string;
  /** What the preset is for, in the operator's terms. */
  explanation: string;
  securityProfile: SecurityProfile;
  /** A complete, validatable starting policy. Addresses are placeholders. */
  config: PolicyConfig;
}

/** Placeholder SAC token contract — replace with the token the agent may move. */
export const PRESET_PLACEHOLDER_ASSET =
  "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";

/** Placeholder recipient — replace with an address you control before installing. */
export const PRESET_PLACEHOLDER_RECIPIENT =
  "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

/** Placeholder DEX contract — replace with the protocol the agent may call. */
export const PRESET_PLACEHOLDER_DEX =
  "CDPPYSSNYEEUBHASLCLTPGGP7W573NUK6KZETVX5AAAJX32TYMCXRIWC";

/** Second placeholder protocol, so per-function and any-function rules both appear. */
export const PRESET_PLACEHOLDER_DEX_ALT =
  "CC7XRH6ZKVQZ7XZO64OUUJ7OV3GNKIBMPA3RKO4BMLYSEVP3FQN7AILU";

/**
 * The presets themselves.
 *
 * Each is built so the local form validation (`buildPolicyConfig`) and the
 * contract's own `validate_config` rules both accept it unchanged — that is the
 * property `tests/unit/presets.test.ts` pins down.
 */
export const POLICY_PRESETS: readonly PolicyPreset[] = [
  {
    id: "strict-micro-agent",
    name: "Strict Micro-Agent",
    explanation:
      "Low caps, a strict recipient allowlist and a one-hour dead-man switch. Best for an experimental or narrowly scoped agent whose loss must stay small. Replace the placeholder asset and recipient before installing.",
    securityProfile: "conservative",
    config: {
      per_tx_cap: 100n,
      window_secs: 86400n,
      window_cap: 500n,
      assets: [PRESET_PLACEHOLDER_ASSET],
      protocols: [],
      recipients: [PRESET_PLACEHOLDER_RECIPIENT],
      allow_any_recipient: false,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      // A short grace means a stalled agent freezes quickly rather than
      // spending unattended for a full day.
      dms_grace_secs: 3600n,
    },
  },
  {
    id: "standard-defi-bot",
    name: "Standard DeFi Bot",
    explanation:
      "Moderate caps, a per-function DEX allowlist and a daily dead-man switch. Best for a steady production agent doing swaps and deposits. Replace the placeholder asset, recipient and protocol contracts before installing.",
    securityProfile: "balanced",
    config: {
      per_tx_cap: 1000n,
      window_secs: 86400n,
      window_cap: 10000n,
      assets: [PRESET_PLACEHOLDER_ASSET],
      protocols: [{ contract: PRESET_PLACEHOLDER_DEX, fns: ["swap", "deposit"] }],
      recipients: [PRESET_PLACEHOLDER_RECIPIENT],
      allow_any_recipient: false,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      // A full day of grace matches an agent whose heartbeat runs on a daily
      // maintenance cycle.
      dms_grace_secs: 86400n,
    },
  },
  {
    id: "high-throughput-arbitrage",
    name: "High-Throughput Arbitrage",
    explanation:
      "A large seven-day rolling window, wide per-transaction headroom and a fifteen-minute dead-man switch. Best for a latency-sensitive arbitrage agent that must keep trading. Replace the placeholder asset, recipient and protocol contracts before installing.",
    securityProfile: "permissive",
    config: {
      per_tx_cap: 100000n,
      window_secs: 604800n,
      window_cap: 5000000n,
      assets: [PRESET_PLACEHOLDER_ASSET],
      protocols: [
        { contract: PRESET_PLACEHOLDER_DEX, fns: null },
        { contract: PRESET_PLACEHOLDER_DEX_ALT, fns: ["swap"] },
      ],
      recipients: [PRESET_PLACEHOLDER_RECIPIENT],
      allow_any_recipient: false,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      // Arbitrage stalls if the switch waits long; a short grace trades uptime
      // for a fast stop.
      dms_grace_secs: 900n,
    },
  },
];

/** Look up a preset by its stable id. Returns `undefined` for unknown input. */
export function policyPresetById(id: string): PolicyPreset | undefined {
  return POLICY_PRESETS.find((preset) => preset.id === id);
}

/** The profile metadata a badge renders from. */
export function securityProfileMeta(profile: SecurityProfile): SecurityProfileMeta {
  return SECURITY_PROFILES[profile];
}

/**
 * Turn a preset into the plain draft the form edits, preserving the config's
 * `bigint` precision by rendering each cap as a decimal string.
 */
export function draftFromPreset(preset: PolicyPreset): PolicyDraft {
  return draftFromConfig(preset.config);
}
