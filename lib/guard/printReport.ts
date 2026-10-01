import type { GuardSnapshot } from "./guardOps.ts";
import { describePolicy, isDeadManFrozen } from "stellar-agent-guard-sdk";

export interface AuditReport {
  contractId: string;
  bytecodeHash: string;
  policyRules: string;
  allowlists: {
    assets: string[];
    recipients: string[];
    protocols: string[];
  };
  adminKey: string;
  dmsStatus: string;
  network: string;
  timestamp: string;
}

export function compilePrintReport(
  snapshot: GuardSnapshot,
  networkName: string,
  adminKey: string,
): AuditReport {
  const policy = snapshot.policy.ok ? snapshot.policy.value : null;
  const status = snapshot.status.ok ? snapshot.status.value : null;

  return {
    contractId: snapshot.guard,
    bytecodeHash: snapshot.identity.ok ? (snapshot.identity.value.reportedWasmHash ?? "-") : "-",
    policyRules: policy ? describePolicy(policy) : "No policy installed",
    allowlists: {
      assets: policy ? policy.assets : [],
      recipients: policy ? (policy.allow_any_recipient ? ["* (Any)"] : policy.recipients) : [],
      protocols: policy
        ? policy.protocols.map((p) => `${p.contract} ${p.fns ? `(${p.fns.join(", ")})` : "(Any)"}`)
        : [],
    },
    adminKey,
    dmsStatus: status
      ? isDeadManFrozen(status)
        ? "FIRED"
        : status.heartbeat_expired
          ? "EXPIRED"
          : "OK"
      : "UNKNOWN",
    network: networkName,
    timestamp: new Date().toISOString(),
  };
}
