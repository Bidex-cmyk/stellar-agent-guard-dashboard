import type { PolicyConfig } from "stellar-agent-guard-sdk";

export interface DiffEntry {
  field: keyof PolicyConfig;
  oldValue: any;
  newValue: any;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
}

export interface PolicyDiff {
  entries: DiffEntry[];
  warnings: string[];
}

export function computePolicyDiff(oldConfig: PolicyConfig | null, newConfig: PolicyConfig): PolicyDiff {
  const entries: DiffEntry[] = [];
  const warnings: string[] = [];

  if (!oldConfig) {
    return {
      entries: Object.keys(newConfig).map(k => ({
        field: k as keyof PolicyConfig,
        oldValue: undefined,
        newValue: (newConfig as any)[k],
        status: 'added'
      })),
      warnings: []
    };
  }

  for (const key of Object.keys(newConfig) as Array<keyof PolicyConfig>) {
    const oldVal = oldConfig[key];
    const newVal = newConfig[key];

    let status: DiffEntry['status'] = 'unchanged';
    if (JSON.stringify(oldVal, (k, v) => typeof v === 'bigint' ? v.toString() : v) !== JSON.stringify(newVal, (k, v) => typeof v === 'bigint' ? v.toString() : v)) {
      status = 'modified';
    }

    entries.push({
      field: key,
      oldValue: oldVal,
      newValue: newVal,
      status
    });
  }

  if (newConfig.window_cap > 0n && oldConfig.window_cap > 0n && newConfig.window_cap < oldConfig.window_cap) {
    warnings.push('New policy lowers the rolling-window cap.');
  }

  if (newConfig.dms_grace_secs > 0n && oldConfig.dms_grace_secs > 0n && newConfig.dms_grace_secs < oldConfig.dms_grace_secs) {
    warnings.push('New policy shortens the dead-man switch grace period.');
  }

  return { entries, warnings };
}
