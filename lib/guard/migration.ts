/**
 * Moving a policy from one guard to another.
 *
 * Upgrading usually means a new contract address and the same thirty rules
 * re-entered by hand — the point at which an operator's careful allowlist turns
 * into a typo'd one. The read side is already here: `readPolicy` returns a
 * deployed guard's `PolicyConfig`, and `policyForm.ts` converts that shape to
 * and from the operator's form. What was missing is the step between them: say
 * what the source actually holds, prove the target can accept it, and hand over
 * an installable draft instead of a shrug.
 *
 * Nothing here writes to a chain. A migration is *prepared* — the payload the
 * target's `set_policy` would receive — and the operator still signs it in the
 * same way they sign any other policy change.
 */

import type { PolicyConfig, ProtocolRule } from "stellar-agent-guard-sdk";
import { buildPolicyConfig, draftFromConfig, type PolicyDraft } from "./policyForm.ts";

/** One field of the target contract's `PolicyConfig`, as the form needs it. */
export interface TargetField {
  name: string;
  /** A field the contract's struct has no default for: migration must supply it. */
  required: boolean;
  /** What it means, in the operator's words, for the review step. */
  label: string;
}

/**
 * The schema this build writes. Field names are exactly the contract's
 * `PolicyConfig` fields (see `PolicyConfig` in the SDK), so a source that
 * disagrees with this list is a source from a different contract version —
 * which is the thing an operator needs told before, not after, a migration.
 */
export const TARGET_POLICY_FIELDS: readonly TargetField[] = [
  { name: "per_tx_cap", required: true, label: "per-transaction cap" },
  { name: "window_secs", required: true, label: "rolling-window length" },
  { name: "window_cap", required: true, label: "rolling-window cap" },
  { name: "assets", required: true, label: "asset allowlist" },
  { name: "protocols", required: true, label: "protocol allowlist" },
  { name: "recipients", required: true, label: "recipient allowlist" },
  { name: "allow_any_recipient", required: true, label: "allow-any-recipient flag" },
  { name: "active_from", required: true, label: "active-from timestamp" },
  { name: "active_until", required: true, label: "active-until timestamp" },
  { name: "paused", required: true, label: "paused flag" },
  { name: "dms_grace_secs", required: true, label: "dead-man grace" },
];

/**
 * Key spellings folded onto the contract's field names.
 *
 * A policy that left this dashboard as JSON, or was hand-copied out of an
 * explorer, arrives in camelCase or with a word swapped. Folding those is not
 * the same as claiming an old contract used them: anything that does not fold
 * onto a target field is reported as unknown rather than quietly dropped.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  // Keys are the punctuation-free, lowercased spelling `foldKey` produces.
  pertxcap: "per_tx_cap",
  pertxlimit: "per_tx_cap",
  windowsecs: "window_secs",
  windowlengthsecs: "window_secs",
  windowcap: "window_cap",
  windowlimit: "window_cap",
  allowanyrecipient: "allow_any_recipient",
  anyrecipient: "allow_any_recipient",
  activefrom: "active_from",
  activeuntil: "active_until",
  dmgracesecs: "dms_grace_secs",
  dmsgracesecs: "dms_grace_secs",
  dmsgrace: "dms_grace_secs",
  recipientallowlist: "recipients",
  protocolallowlist: "protocols",
  assetallowlist: "assets",
};

function foldKey(key: string): string {
  const cleaned = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return KEY_ALIASES[cleaned] ?? key.toLowerCase();
}

export interface CompatibilityReport {
  /** A migration can be prepared: every target field is present and typed. */
  ok: boolean;
  /** Target fields the source does not carry: they must be re-entered. */
  missing: string[];
  /** Source fields with no target counterpart: they will not survive the move. */
  unrecognised: string[];
  /** Fields that arrived under a folded name, so the operator sees the mapping. */
  renamed: Array<{ from: string; to: string }>;
  /** Present but the wrong shape (a cap that is a string, an allowlist that is not a list). */
  typeIssues: string[];
  notes: string[];
}

/**
 * Compare a source policy against this build's schema.
 *
 * The report is deliberately triple-columned — missing, folded, unrecognised —
 * because "the migration failed" and "the migration dropped three rules" are
 * different mistakes, and only the first one announces itself.
 */
export function validateSourcePolicy(source: unknown): CompatibilityReport {
  const missing: string[] = [];
  const unrecognised: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const typeIssues: string[] = [];
  const notes: string[] = [];

  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return {
      ok: false,
      missing: TARGET_POLICY_FIELDS.map((field) => field.name),
      unrecognised: [],
      renamed: [],
      typeIssues: [],
      notes: ["The source returned no policy object: it is unreadable, not empty."],
    };
  }

  const raw = source as Record<string, unknown>;
  const mapped = new Map<string, { value: unknown; from: string }>();
  for (const [key, value] of Object.entries(raw)) {
    const target = foldKey(key);
    if (!TARGET_POLICY_FIELDS.some((field) => field.name === target)) {
      unrecognised.push(key);
      continue;
    }
    if (target !== key.toLowerCase()) renamed.push({ from: key, to: target });
    const already = mapped.get(target);
    if (already) {
      notes.push(`Both "${already.from}" and "${key}" map to ${target}; the first one is used.`);
      continue;
    }
    mapped.set(target, { value, from: key });
  }

  for (const field of TARGET_POLICY_FIELDS) {
    const entry = mapped.get(field.name);
    if (!entry) {
      missing.push(field.name);
      continue;
    }
    const issue = checkType(field.name, entry.value);
    if (issue) typeIssues.push(issue);
  }

  const protocols = mapped.get("protocols")?.value;
  if (Array.isArray(protocols) && protocols.some((rule) => !isProtocolRule(rule))) {
    typeIssues.push("protocols: at least one entry is not a { contract, fns } rule");
  }
  if (mapped.get("allow_any_recipient")?.value === true) {
    notes.push(
      "The source allows any recipient; that is the widest recipient rule the contract supports, and it moves across as-is.",
    );
  }

  return {
    ok: missing.length === 0 && typeIssues.length === 0,
    missing,
    unrecognised,
    renamed,
    typeIssues,
    notes,
  };
}

function checkType(name: string, value: unknown): string | null {
  const capFields = new Set([
    "per_tx_cap",
    "window_secs",
    "window_cap",
    "active_from",
    "active_until",
    "dms_grace_secs",
  ]);
  const listFields = new Set(["assets", "recipients"]);
  if (capFields.has(name)) {
    if (typeof value === "bigint" || typeof value === "number") return null;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return null;
    return `${name}: expected a whole number of units, got ${describe(value)}`;
  }
  if (listFields.has(name)) {
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return null;
    return `${name}: expected a list of addresses, got ${describe(value)}`;
  }
  if (name === "protocols") {
    if (Array.isArray(value)) return null;
    return `protocols: expected a list of protocol rules, got ${describe(value)}`;
  }
  if (name === "paused" || name === "allow_any_recipient") {
    if (typeof value === "boolean") return null;
    return `${name}: expected true or false, got ${describe(value)}`;
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return `a ${typeof value}`;
}

function isProtocolRule(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const rule = value as { contract?: unknown; fns?: unknown };
  return typeof rule.contract === "string" && (rule.fns === null || Array.isArray(rule.fns));
}

/** Normalise a source object into the shape `draftFromConfig` consumes. */
function toPolicyConfig(source: Record<string, unknown>): PolicyConfig {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const target = foldKey(key);
    if (mapped[target] !== undefined) continue;
    mapped[target] = target === "protocols" ? normaliseProtocols(value) : value;
  }
  const cap = (name: string): bigint => {
    const value = mapped[name];
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
    return 0n;
  };
  return {
    per_tx_cap: cap("per_tx_cap"),
    window_secs: cap("window_secs"),
    window_cap: cap("window_cap"),
    assets: toStringList(mapped.assets),
    protocols: Array.isArray(mapped.protocols) ? (mapped.protocols as ProtocolRule[]) : [],
    recipients: toStringList(mapped.recipients),
    allow_any_recipient: mapped.allow_any_recipient === true,
    active_from: cap("active_from"),
    active_until: cap("active_until"),
    paused: mapped.paused === true,
    dms_grace_secs: cap("dms_grace_secs"),
  };
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normaliseProtocols(value: unknown): ProtocolRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule): rule is ProtocolRule => isProtocolRule(rule))
    .map((rule) => ({
      contract: rule.contract,
      fns: Array.isArray(rule.fns)
        ? rule.fns.filter((fn): fn is string => typeof fn === "string")
        : null,
    }));
}

export type MigrationPlan =
  | {
      ok: true;
      source: PolicyConfig;
      draft: PolicyDraft;
      report: CompatibilityReport;
      /** The exact description `installPolicy` will put on chain. */
      summary: string;
      /** What the move changes, in the operator's terms. */
      carried: string[];
      dropped: string[];
    }
  | { ok: false; report: CompatibilityReport; message: string };

/**
 * Read a source policy and prepare the target's `set_policy` payload.
 *
 * The draft round-trips through the form's own validator
 * (`buildPolicyConfig`), so a policy that could not be installed had it been
 * typed by hand cannot be installed by migration either. That is the whole
 * guarantee this function offers, and it is why it refuses on an incomplete
 * source instead of filling in blanks: a zeroed cap is a silent policy change.
 */
export function planMigration(source: unknown): MigrationPlan {
  const report = validateSourcePolicy(source);
  if (!report.ok) {
    const parts: string[] = [];
    if (report.missing.length > 0) parts.push(`missing ${report.missing.join(", ")}`);
    if (report.typeIssues.length > 0) parts.push(report.typeIssues.join("; "));
    return {
      ok: false,
      report,
      message: `The source policy is not directly portable: ${parts.join("; ")}.`,
    };
  }

  const config = toPolicyConfig(source as Record<string, unknown>);
  const draft = draftFromConfig(config);
  const built = buildPolicyConfig(draft);
  if (!built.ok) {
    return {
      ok: false,
      report,
      message: `The migrated policy fails this build's validation: ${built.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}.`,
    };
  }

  const carried: string[] = [];
  if (config.per_tx_cap > 0n) carried.push(`per-transaction cap ${config.per_tx_cap}`);
  if (config.window_cap > 0n)
    carried.push(`rolling cap ${config.window_cap} per ${config.window_secs}s`);
  if (config.assets.length > 0) carried.push(`${config.assets.length} asset(s)`);
  if (config.recipients.length > 0) carried.push(`${config.recipients.length} recipient(s)`);
  if (config.protocols.length > 0) carried.push(`${config.protocols.length} protocol rule(s)`);
  if (config.allow_any_recipient) carried.push("any recipient allowed");
  if (config.dms_grace_secs > 0n) carried.push(`dead-man grace ${config.dms_grace_secs}s`);
  if (config.paused) carried.push("installed in the paused state");

  const dropped = report.unrecognised.map((field) => `${field} (no field on this build's policy)`);

  return {
    ok: true,
    source: config,
    draft,
    report,
    summary: describeMigrationSummary(config, dropped),
    carried,
    dropped,
  };
}

function describeMigrationSummary(config: PolicyConfig, dropped: readonly string[]): string {
  const parts = [
    config.per_tx_cap > 0n ? `per-tx ${config.per_tx_cap}` : "no per-tx cap",
    config.window_cap > 0n ? `window ${config.window_cap}/${config.window_secs}s` : "no window cap",
    `${config.assets.length} asset(s)`,
    config.allow_any_recipient ? "any recipient" : `${config.recipients.length} recipient(s)`,
    `${config.protocols.length} protocol rule(s)`,
    config.dms_grace_secs > 0n ? `dead-man ${config.dms_grace_secs}s` : "dead-man off",
    config.paused ? "PAUSED on install" : "active on install",
  ];
  if (dropped.length > 0) parts.push(`${dropped.length} source field(s) not carried`);
  return parts.join(" · ");
}

/** The fields a review step shows, so an operator can eyeball the whole policy. */
export function sourceRows(source: PolicyConfig): Array<{ label: string; value: string }> {
  return [
    { label: "Per-transaction cap", value: configText(source.per_tx_cap) },
    {
      label: "Rolling window",
      value: `${configText(source.window_cap)} every ${configText(source.window_secs)}s`,
    },
    { label: "Assets", value: listOr(source.assets, "none — every asset is denied") },
    {
      label: "Recipients",
      value: source.allow_any_recipient
        ? "any recipient"
        : listOr(source.recipients, "none — every recipient is denied"),
    },
    {
      label: "Protocols",
      value: listOr(
        source.protocols.map((rule) =>
          rule.fns && rule.fns.length > 0
            ? `${rule.contract}:${rule.fns.join(",")}`
            : rule.contract,
        ),
        "none",
      ),
    },
    {
      label: "Active window",
      value:
        source.active_from === 0n && source.active_until === 0n
          ? "always"
          : `${configText(source.active_from)} → ${configText(source.active_until)}`,
    },
    { label: "Paused", value: source.paused ? "yes" : "no" },
    {
      label: "Dead-man grace",
      value: source.dms_grace_secs > 0n ? `${configText(source.dms_grace_secs)}s` : "off",
    },
  ];
}

function configText(value: bigint): string {
  return value === 0n ? "0" : value.toString();
}

function listOr(items: readonly string[], whenEmpty: string): string {
  return items.length === 0 ? whenEmpty : items.join(", ");
}
