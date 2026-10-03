import assert from "node:assert/strict";
import { test } from "node:test";
import { Address, scValToNative } from "@stellar/stellar-sdk";
import { policyToScVal } from "stellar-agent-guard-sdk";
import {
  POLICY_PRESETS,
  SECURITY_PROFILES,
  draftFromPreset,
  policyPresetById,
  securityProfileMeta,
  type SecurityProfile,
} from "../../lib/guard/presets.ts";
import { buildPolicyConfig } from "../../lib/guard/policyForm.ts";

const ALL_PROFILES = Object.keys(SECURITY_PROFILES) as SecurityProfile[];

test("presets have unique ids and complete, descriptive metadata", () => {
  const seen = new Set<string>();
  for (const preset of POLICY_PRESETS) {
    assert.equal(seen.has(preset.id), false, `duplicate preset id: ${preset.id}`);
    seen.add(preset.id);
    assert.ok(preset.name.trim().length > 0, `${preset.id} has no name`);
    assert.ok(preset.explanation.trim().length > 0, `${preset.id} has no explanation`);
    assert.ok(ALL_PROFILES.includes(preset.securityProfile), `${preset.id} has an unknown profile`);
    assert.equal(policyPresetById(preset.id), preset, `${preset.id} is not addressable by id`);
  }
  // The issue asks for three named archetypes; guard against one being dropped.
  assert.ok(POLICY_PRESETS.length >= 3, "expected at least three presets");
});

test("the preset set covers every security profile", () => {
  const used = new Set(POLICY_PRESETS.map((preset) => preset.securityProfile));
  for (const profile of ALL_PROFILES) {
    assert.ok(used.has(profile), `no preset exercises the ${profile} profile`);
  }
});

test("each security profile maps to a labelled, colour-coded badge", () => {
  for (const profile of ALL_PROFILES) {
    const meta = securityProfileMeta(profile);
    assert.ok(meta.label.trim().length > 0, `${profile} has no label`);
    assert.ok(meta.description.trim().length > 0, `${profile} has no description`);
    assert.ok(
      ["ok", "warn", "danger"].includes(meta.pillClass),
      `${profile} uses an unknown pill class`,
    );
  }
});

test("every preset passes the form's schema validation unchanged", () => {
  // `buildPolicyConfig` is the schema gate the form itself uses: caps parse as
  // whole numbers, addresses are valid strkeys, and the cross-field rules hold.
  // A preset that fails here could never be installed from the UI.
  for (const preset of POLICY_PRESETS) {
    const built = buildPolicyConfig(draftFromPreset(preset));
    assert.equal(
      built.ok,
      true,
      `${preset.id} failed schema validation: ${built.ok ? "" : JSON.stringify(built.issues)}`,
    );
  }
});

test("every preset encodes to the struct the contract decodes", () => {
  // The contract decodes a `#[contracttype]` struct from a sorted `ScVal::Map`
  // exactly as `scValToNative` does, so a round trip proves the preset is the
  // shape `set_policy` accepts — field names, types and ordering included.
  for (const preset of POLICY_PRESETS) {
    const decoded = scValToNative(policyToScVal(preset.config)) as Record<string, unknown>;
    assert.equal(decoded["per_tx_cap"], preset.config.per_tx_cap, preset.id);
    assert.equal(decoded["window_cap"], preset.config.window_cap, preset.id);
    assert.equal(decoded["window_secs"], preset.config.window_secs, preset.id);
    assert.equal(decoded["dms_grace_secs"], preset.config.dms_grace_secs, preset.id);
    assert.equal(decoded["active_from"], preset.config.active_from, preset.id);
    assert.equal(decoded["active_until"], preset.config.active_until, preset.id);
    assert.deepEqual(decoded["assets"], preset.config.assets, preset.id);
    assert.deepEqual(decoded["recipients"], preset.config.recipients, preset.id);
    assert.equal(decoded["allow_any_recipient"], preset.config.allow_any_recipient, preset.id);
    assert.equal(decoded["paused"], preset.config.paused, preset.id);
    assert.deepEqual(decoded["protocols"], preset.config.protocols, preset.id);
  }
});

test("every preset satisfies the contract's cross-field validation rules", () => {
  for (const preset of POLICY_PRESETS) {
    const config = preset.config;

    // A rolling cap with no window length can never apply.
    if (config.window_cap > 0n) {
      assert.ok(config.window_secs > 0n, `${preset.id}: rolling cap without a window length`);
    }
    // A window smaller than one permitted transaction can never be filled.
    assert.ok(
      config.window_cap >= config.per_tx_cap,
      `${preset.id}: window cap is below the per-transaction cap`,
    );
    // Caps and grace are non-negative (they cross the wire as i128/u64).
    assert.ok(config.per_tx_cap >= 0n, preset.id);
    assert.ok(config.window_cap >= 0n, preset.id);
    assert.ok(config.window_secs >= 0n, preset.id);
    assert.ok(config.dms_grace_secs >= 0n, preset.id);
    // No preset installs paused: it would refuse every call until resumed.
    assert.equal(config.paused, false, `${preset.id} installs paused`);

    // Every address is a valid Stellar strkey, so the encoder cannot throw.
    for (const address of [...config.assets, ...config.recipients]) {
      assert.doesNotThrow(() => Address.fromString(address), `${preset.id}: invalid ${address}`);
    }
    for (const rule of config.protocols) {
      assert.doesNotThrow(
        () => Address.fromString(rule.contract),
        `${preset.id}: invalid protocol ${rule.contract}`,
      );
    }

    // With assets listed and the allowlist on, an empty recipient list would
    // refuse every transfer — the lockout `validate_config` is meant to catch.
    if (!config.allow_any_recipient && config.assets.length > 0) {
      assert.ok(config.recipients.length > 0, `${preset.id}: allowlist on with no recipients`);
    }
  }
});

test("applying a preset survives a draft round trip", () => {
  for (const preset of POLICY_PRESETS) {
    const first = buildPolicyConfig(draftFromPreset(preset));
    assert.equal(first.ok, true, preset.id);
    if (!first.ok) continue;
    // Rendering the built config back to a draft and re-validating must be a
    // no-op, or selecting a preset would silently change it on the next edit.
    const again = buildPolicyConfig(draftFromPreset({ ...preset, config: first.config }));
    assert.equal(again.ok, true, preset.id);
    if (!again.ok) continue;
    assert.deepEqual(again.config, first.config, preset.id);
  }
});
