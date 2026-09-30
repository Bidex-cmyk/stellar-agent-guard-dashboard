import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computePolicyDiff } from '../../lib/guard/policyDiff';
import type { PolicyConfig } from "stellar-agent-guard-sdk";

const emptyConfig: PolicyConfig = {
  per_tx_cap: 0n, window_secs: 86400n, window_cap: 0n,
  assets: [], protocols: [], recipients: [], allow_any_recipient: false,
  active_from: 0n, active_until: 0n, paused: false, dms_grace_secs: 0n,
};

describe('policyDiff', () => {
  it('computes diff for modified config', () => {
    const newConfig = { ...emptyConfig, window_cap: 100n };
    const diff = computePolicyDiff(emptyConfig, newConfig);
    const windowCapEntry = diff.entries.find(e => e.field === 'window_cap');
    assert.strictEqual(windowCapEntry?.status, 'modified');
    assert.strictEqual(diff.warnings.length, 0);
  });

  it('generates warnings for lowered caps', () => {
    const oldConfig = { ...emptyConfig, window_cap: 100n, dms_grace_secs: 100n };
    const newConfig = { ...emptyConfig, window_cap: 50n, dms_grace_secs: 50n };
    const diff = computePolicyDiff(oldConfig, newConfig);
    assert.strictEqual(diff.warnings.length, 2);
  });
});
