/**
 * Read-only inspection of a guard instance, using the same library the console
 * uses. Useful for checking state without a browser, and for confirming what a
 * given address actually is before operating it.
 *
 * Usage:
 *   node scripts/inspect-instance.ts [--guard C…] [--json]
 */

import { readPolicy, readStatus, readWindow, verifyWasmIdentity, createServer } from "../lib/guard/chain.ts";
import { NETWORK, PHASE1_ARTIFACT } from "../lib/guard/network.ts";
import { describePolicy, isDeadManFrozen, deadManRemaining } from "stellar-agent-guard-sdk";

const server = createServer(NETWORK.rpcUrl);

function json(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token || !token.startsWith("--")) continue;
    const body = token.slice(2);
    const separator = body.indexOf("=");
    if (separator !== -1) {
      flags.set(body.slice(0, separator), body.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      flags.set(body, value);
      index++;
    } else {
      flags.set(body, true);
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const guard = (flags.get("guard") as string | undefined) ?? PHASE1_ARTIFACT.guard;
  const asJson = process.argv.includes("--json") || flags.has("json");

  const [status, policy, window, identity] = await Promise.all([
    readStatus(server, guard),
    readPolicy(server, guard),
    readWindow(server, guard),
    verifyWasmIdentity(server, guard).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);

  const report = {
    schemaVersion: 1,
    rpcUrl: NETWORK.rpcUrl,
    guard,
    artifact: {
      pinned: PHASE1_ARTIFACT.wasmHash,
      ...("error" in identity ? { error: identity.error } : identity),
      isPinnedArtifact:
        !("error" in identity) && identity.fetchedSha256 === PHASE1_ARTIFACT.wasmHash,
    },
    status: status.ok ? status.value : { error: status.error },
    policy: policy.ok ? policy.value : { error: policy.error },
    window: window.ok ? window.value : { error: window.error },
  };

  if (asJson) {
    console.log(json(report));
    return;
  }

  console.log(`RPC                 ${NETWORK.rpcUrl}`);
  console.log(`guard               ${guard}`);
  if ("error" in identity) {
    console.log(`artifact            UNREADABLE — ${identity.error}`);
  } else {
    console.log(`artifact (ledger)   ${identity.reportedWasmHash ?? "(none)"}`);
    console.log(`artifact (fetched)  ${identity.fetchedSha256} (${identity.bytes} bytes)`);
    console.log(`is Phase 1 artifact ${identity.fetchedSha256 === PHASE1_ARTIFACT.wasmHash}`);
  }

  if (!status.ok) {
    // A failed read is reported as a failure, never rendered as empty state.
    console.log(`status              UNREADABLE — ${status.error}`);
  } else {
    console.log(`admin_frozen        ${status.value.admin_frozen}`);
    console.log(`heartbeat_expired   ${status.value.heartbeat_expired}`);
    console.log(`dead-man frozen     ${isDeadManFrozen(status.value)}`);
    console.log(`last_heartbeat      ${status.value.last_heartbeat}`);
    console.log(`now                 ${status.value.now}`);
  }

  if (!policy.ok) {
    console.log(`policy              UNREADABLE — ${policy.error}`);
  } else if (policy.value === null) {
    console.log(`policy              none installed — the account is default-deny`);
  } else {
    console.log(`policy              ${describePolicy(policy.value)}`);
    console.log(
      `dead-man remaining  ${
        status.ok ? String(deadManRemaining(status.value, policy.value)) : "unknown (status unreadable)"
      }`,
    );
  }

  if (!window.ok) {
    console.log(`window              UNREADABLE — ${window.error}`);
  } else if (window.value === null) {
    console.log(`window              no spend recorded`);
  } else {
    console.log(`window total        ${window.value.total} across ${window.value.entries.length} entry(ies)`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
