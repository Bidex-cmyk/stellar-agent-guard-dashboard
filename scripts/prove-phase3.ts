/**
 * Phase 3 end-to-end proof, driven headlessly against Stellar testnet.
 *
 * This script exists because the console's claims have to be checkable without a
 * browser. It drives **the same modules the UI calls** — `lib/guard/guardOps.ts`
 * for the deploy/initialize/policy/freeze path and `lib/guard/telemetry.ts` for
 * the feed — with the only substitution being the wallet: a `WalletSigner` backed
 * by a keypair instead of Freighter. That substitution is the whole reason
 * `WalletSigner` is a seam, and it is why this run is evidence about the console's
 * logic rather than about a re-implementation of it.
 *
 * What it proves, in order:
 *   1. the pinned Phase 1 artifact is re-derived from the chain and matches;
 *   2. a real guard instance is deployed from those exact bytes;
 *   3. `initialize` registers an admin and an agent;
 *   4. a policy installs, and an agent-authorized SAC transfer passes `__check_auth`;
 *   5. the panic button freezes the account, and the *same* transfer is then
 *      refused by `__check_auth` with `admin_frozen` — confirmed by re-reading
 *      `status()` from the chain, not by trusting the write's own response;
 *   6. `unfreeze` restores it, and the same transfer passes again;
 *   7. the telemetry feed reads the lifecycle events those writes emitted.
 *
 * Usage: node scripts/prove-phase3.ts
 * Writes tests/fixtures/phase3-proof.json (public) and .env.phase3 (gitignored).
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Asset,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  Address,
  Account,
} from "@stellar/stellar-sdk";
import { invoke } from "stellar-agent-guard-sdk";
import { guardEventsFromDiagnostics } from "stellar-agent-guard-sdk";
import {
  checkArtifact,
  deployGuard,
  freezeGuard,
  initializeGuard,
  installPolicy,
  unfreezeGuard,
  planDeploy,
} from "../lib/guard/guardOps.ts";
import { readStatus, createServer } from "../lib/guard/chain.ts";
import { GuardFeed } from "../lib/guard/telemetry.ts";
import { NETWORK, PHASE1_ARTIFACT, ENFORCEMENT_SCOPE_STATEMENT } from "../lib/guard/network.ts";
import type { WalletSigner } from "../lib/guard/submit.ts";
import type { PolicyDraft } from "../lib/guard/policyForm.ts";

const ENV_PATH = ".env.phase3";
const FIXTURE_PATH = "tests/fixtures/phase3-proof.json";
const ASSET_CODE = "P3GUARD";
const MINT_AMOUNT = 100_000n;
const TRUSTLINE_LIMIT = 1_000_000n;
const SALT_SEED = "stellar-agent-guard:dashboard:phase3:guard:1";

const server = createServer(NETWORK.rpcUrl);

// ── A wallet signer backed by a keypair ────────────────────────────────────
// The only place this script differs from the browser: the same three methods
// the Freighter adapter implements, with a local key instead of an extension.
function keypairSigner(keypair: Keypair): WalletSigner {
  return {
    address: keypair.publicKey(),
    async signTransaction(transactionXdr: string): Promise<string> {
      const transaction = TransactionBuilder.fromXDR(transactionXdr, NETWORK.passphrase);
      transaction.sign(keypair);
      return transaction.toXDR();
    },
    async signAuthEntry(entryXdr: string): Promise<string> {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
      const latest = await server.getLatestLedger();
      const signed = await authorizeEntry(
        entry,
        keypair,
        latest.sequence + 1_000,
        NETWORK.passphrase,
      );
      return signed.toXDR("base64");
    },
  };
}

// ── logging ────────────────────────────────────────────────────────────────
const log: string[] = [];
function step(message: string): void {
  console.log(message);
  log.push(message);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

// ── key management ─────────────────────────────────────────────────────────
async function readEnv(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(ENV_PATH, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index > 0) out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
    return out;
  } catch {
    return {};
  }
}

async function writeEnv(values: Record<string, string>): Promise<void> {
  await writeFile(
    ENV_PATH,
    [
      "# Phase 3 proof secrets — written by scripts/prove-phase3.ts",
      "# Testnet only. Never reuse these keys on any other network.",
      ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
      "",
    ].join("\n"),
  );
}

async function fund(publicKey: string): Promise<void> {
  try {
    await server.fundAddress(publicKey);
    return;
  } catch {
    const response = await fetch(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
    );
    if (!response.ok)
      throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${response.status}`);
  }
}

// ── generic submit for setup steps (classic + host functions) ──────────────
async function submitSimple(
  operation: xdr.Operation,
  signer: Keypair,
): Promise<{ hash: string; ledger: number | null }> {
  const account = await server.getAccount(signer.publicKey());
  const built = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  const isHostFunction =
    (operation as unknown as { body?: { type?: string } }).body?.type === "invokeHostFunction";
  const prepared = isHostFunction ? await server.prepareTransaction(built) : built;
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR")
    throw new Error(`submit rejected: ${json(sent.errorResult ?? sent)}`);
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: sent.hash, ledger: (result as { ledger?: number }).ledger ?? null };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`tx ${sent.hash} failed: ${json(result)}`);
    }
  }
  throw new Error(`timed out waiting for ${sent.hash}`);
}

/** Read a contract view function via simulation. */
async function readView<T = unknown>(
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  source: string,
): Promise<{ value?: T; error?: string }> {
  const account = new Account(source, "0");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK.passphrase })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    return {
      error:
        typeof simulation.error === "string" ? simulation.error : JSON.stringify(simulation.error),
    };
  }
  const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
  const retval = success.result?.retval;
  if (retval === undefined) return { error: `${fn}() returned no value` };
  return { value: scValToNative(retval) as T };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const existing = await readEnv();
  const record: Record<string, unknown> = {
    network: NETWORK.name,
    rpcUrl: NETWORK.rpcUrl,
    networkPassphrase: NETWORK.passphrase,
    ranAt: new Date().toISOString(),
    enforcementScopeStatement: ENFORCEMENT_SCOPE_STATEMENT,
    note:
      "Produced by scripts/prove-phase3.ts, which drives the same lib/guard modules the console " +
      "calls, with the wallet substituted for a keypair. Every transaction hash below is a real " +
      "testnet transaction, re-readable from the RPC.",
  };

  // ── 0. artifact identity ───────────────────────────────────────────────
  step("[0] pinned Phase 1 artifact, re-derived from the chain");
  const artifact = await checkArtifact(server);
  step(`    pinned       ${artifact.pinnedHash} (${artifact.pinnedBytes} bytes)`);
  step(`    fetched      ${artifact.live.fetchedSha256} (${artifact.live.bytes} bytes)`);
  step(`    identity ok  ${artifact.ok}`);
  record.artifact = {
    pinnedHash: artifact.pinnedHash,
    pinnedBytes: artifact.pinnedBytes,
    fetchedSha256: artifact.live.fetchedSha256,
    fetchedBytes: artifact.live.bytes,
    reportedWasmHash: artifact.live.reportedWasmHash,
    ok: artifact.ok,
    detail: artifact.detail,
  };
  if (!artifact.ok) throw new Error(`refusing to continue: ${artifact.detail}`);

  // ── 1. keys ────────────────────────────────────────────────────────────
  const fromEnv = (name: string): Keypair | null =>
    existing[name] ? Keypair.fromSecret(existing[name]!) : null;
  const created: string[] = [];
  const admin = fromEnv("PHASE3_ADMIN_SECRET") ?? (created.push("admin"), Keypair.random());
  const agent = fromEnv("PHASE3_AGENT_SECRET") ?? (created.push("agent"), Keypair.random());
  const issuer = fromEnv("PHASE3_ISSUER_SECRET") ?? (created.push("issuer"), Keypair.random());
  const recipient =
    fromEnv("PHASE3_RECIPIENT_SECRET") ?? (created.push("recipient"), Keypair.random());
  step(
    `[1] keys: ${created.length === 0 ? "reused from .env.phase3" : `generated ${created.join(", ")}`}`,
  );
  for (const name of created) {
    const keypair = { admin, agent, issuer, recipient }[
      name as "admin" | "agent" | "issuer" | "recipient"
    ];
    await fund(keypair.publicKey());
    step(`    funded ${name.padEnd(9)} ${keypair.publicKey()}`);
  }
  // Persist the keys before the first write, so a failure part-way through can be
  // resumed against the same accounts instead of orphaning a fresh set each run.
  await writeEnv({
    PHASE3_ADMIN_SECRET: admin.secret(),
    PHASE3_AGENT_SECRET: agent.secret(),
    PHASE3_ISSUER_SECRET: issuer.secret(),
    PHASE3_RECIPIENT_SECRET: recipient.secret(),
  });
  const agentRawPubkey = StrKey.decodeEd25519PublicKey(agent.publicKey());
  const agentPubkeyHex = Buffer.from(agentRawPubkey).toString("hex");
  record.accounts = {
    admin: admin.publicKey(),
    agent: agent.publicKey(),
    agentRawEd25519Pubkey: agentPubkeyHex,
    issuer: issuer.publicKey(),
    recipient: recipient.publicKey(),
  };

  const signer = keypairSigner(admin);

  // ── 2. test token (SAC) so a transfer is a real transfer ───────────────
  const asset = new Asset(ASSET_CODE, issuer.publicKey());
  const token = existing["PHASE3_TOKEN"] ?? asset.contractId(NETWORK.passphrase);
  const decimals = await readView(token, "decimals", [], issuer.publicKey());
  if (decimals.error) {
    step(`[2] deploying a SAC test token ${ASSET_CODE}:${issuer.publicKey()}`);
    const submission = await submitSimple(Operation.createStellarAssetContract({ asset }), issuer);
    step(`    tx ${submission.hash} (ledger ${submission.ledger})`);
    record.tokenCreate = { hash: submission.hash, ledger: submission.ledger, token };
  } else {
    step(`[2] SAC test token already deployed: ${token}`);
    record.tokenCreate = { token, reused: true };
  }
  record.token = token;

  // ── 3. guard deploy ────────────────────────────────────────────────────
  const salt = createHash("sha256").update(SALT_SEED).digest();
  const plan = await planDeploy(server, admin.publicKey(), salt);
  step(`[3] deploy plan`);
  step(`    predicted guard  ${plan.predicted}`);
  step(`    code present     ${plan.codePresent}`);
  let guard = existing["PHASE3_GUARD"] ?? "";
  if (!guard) {
    const outcome = await deployGuard({
      server,
      signer,
      salt,
      onStep: (s) => {
        const r = s.result;
        const tail =
          r.kind === "submitted"
            ? ` tx ${r.hash} (ledger ${r.ledger})`
            : r.kind === "refused"
              ? ` [refused at ${r.stage}] ${r.detail}`
              : ` ${r.detail}`;
        step(`    step: ${s.label}\n          → ${r.kind}${tail}`);
      },
    });
    guard = outcome.guard;
    record.deploy = {
      predicted: plan.predicted,
      guard: outcome.guard,
      verifiedAgainstPin: outcome.verified,
      identity: outcome.identity,
      steps: outcome.steps.map((s) => ({
        label: s.label,
        kind: s.result.kind,
        ...(s.result.kind === "submitted" ? { hash: s.result.hash, ledger: s.result.ledger } : {}),
        ...(s.result.kind !== "submitted" ? { detail: s.result.detail } : {}),
      })),
    };
    if (!outcome.verified) {
      throw new Error(
        `deployed instance does not run the pinned artifact; steps:\n${outcome.steps
          .map(
            (s) =>
              `  ${s.label}\n    → ${s.result.kind} ${
                s.result.kind === "submitted" ? s.result.hash : s.result.detail
              }`,
          )
          .join("\n")}`,
      );
    }
    step(`    deployed ${guard} — verified against the pinned artifact`);
  } else {
    step(`[3] guard already deployed at ${guard}`);
    record.deploy = { guard, reused: true };
  }
  record.guard = guard;
  await writeEnv({
    PHASE3_ADMIN_SECRET: admin.secret(),
    PHASE3_AGENT_SECRET: agent.secret(),
    PHASE3_ISSUER_SECRET: issuer.secret(),
    PHASE3_RECIPIENT_SECRET: recipient.secret(),
    PHASE3_GUARD: guard,
    PHASE3_TOKEN: token,
  });

  // ── 4. initialize ──────────────────────────────────────────────────────
  const beforeInit = await readStatus(server, guard, admin.publicKey());
  const alreadyInitialized = beforeInit.ok
    ? beforeInit.value.has_policy || beforeInit.value.last_heartbeat !== 0n
    : false;
  if (!alreadyInitialized) {
    step("[4] initialize(admin, agent_pubkey)");
    const result = await initializeGuard({ server, signer, guard, agentPubkeyHex });
    step(
      `    → ${result.kind}${result.kind === "submitted" ? ` tx ${result.hash} (ledger ${result.ledger})` : ` ${result.detail}`}`,
    );
    record.initialize =
      result.kind === "submitted"
        ? { hash: result.hash, ledger: result.ledger }
        : { kind: result.kind, detail: result.detail };
    if (result.kind !== "submitted") throw new Error(`initialize did not land: ${result.kind}`);
  } else {
    step("[4] guard already initialized");
    record.initialize = { reused: true };
  }

  // ── 5. policy via the console's own configurator path ──────────────────
  const draft: PolicyDraft = {
    perTxCap: "1000",
    windowCap: "150",
    windowSecs: "60",
    assets: token,
    assetCaps: [],
    recipients: recipient.publicKey(),
    allowAnyRecipient: false,
    protocols: "",
    activeFrom: "",
    activeUntil: "",
    paused: false,
    dmsGraceSecs: "",
  };
  step("[5] install policy through the console's configurator path");
  const installed = await installPolicy({ server, signer, guard, draft });
  if (installed.kind === "invalid")
    throw new Error(`draft rejected by our own validation: ${installed.issues.join("; ")}`);
  step(
    `    → ${installed.result.kind}${
      installed.result.kind === "submitted"
        ? ` tx ${installed.result.hash} (ledger ${installed.result.ledger})`
        : ` ${installed.result.detail}`
    }`,
  );
  record.setPolicy =
    installed.result.kind === "submitted"
      ? { hash: installed.result.hash, ledger: installed.result.ledger }
      : { kind: installed.result.kind, detail: installed.result.detail };
  if (installed.result.kind !== "submitted") throw new Error("set_policy did not land");

  // ── 6. trustline + mint so an agent transfer is a real transfer ────────
  const recipientBalance = await readView(
    token,
    "balance",
    [new Address(recipient.publicKey()).toScVal()],
    issuer.publicKey(),
  );
  if (recipientBalance.error) {
    const submission = await submitSimple(
      Operation.changeTrust({ asset, limit: TRUSTLINE_LIMIT.toString() }),
      recipient,
    );
    step(`[6] recipient trustline tx ${submission.hash}`);
    record.trustline = { hash: submission.hash, ledger: submission.ledger };
  } else {
    step("[6] recipient trustline already present");
  }
  const guardBalance = await readView<bigint>(
    token,
    "balance",
    [new Address(guard).toScVal()],
    issuer.publicKey(),
  );
  const current = typeof guardBalance.value === "bigint" ? guardBalance.value : 0n;
  if (current < MINT_AMOUNT) {
    const mint = await invoke({
      server,
      source: issuer,
      call: {
        contract: token,
        fn: "mint",
        args: [new Address(guard).toScVal(), nativeToScVal(MINT_AMOUNT, { type: "i128" })],
      },
      networkPassphrase: NETWORK.passphrase,
      accountSigners: [issuer],
    });
    if (mint.kind !== "allowed") throw new Error(`mint failed: ${json(mint)}`);
    step(
      `[6] minted ${MINT_AMOUNT} to the guard: tx ${mint.submission.hash} (ledger ${mint.submission.ledger})`,
    );
    record.mint = {
      hash: mint.submission.hash,
      ledger: mint.submission.ledger,
      amount: MINT_AMOUNT.toString(),
    };
  } else {
    step(`[6] guard already holds ${current}`);
  }

  // ── 7. agent transfer passes __check_auth while unfrozen ───────────────
  const transferArgs = (amount: bigint): xdr.ScVal[] => [
    new Address(guard).toScVal(),
    new Address(recipient.publicKey()).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
  ];
  const attemptTransfer = () =>
    invoke({
      server,
      source: admin,
      call: { contract: token, fn: "transfer", args: transferArgs(10n) },
      networkPassphrase: NETWORK.passphrase,
      guardAuth: { guard, agent },
    });

  step("[7] agent-authorized transfer, account NOT frozen");
  const allowed = await attemptTransfer();
  step(
    `    → ${allowed.kind}${
      allowed.kind === "allowed"
        ? ` tx ${allowed.submission.hash} (ledger ${allowed.submission.ledger})`
        : ` ${json(allowed)}`
    }`,
  );
  record.transferWhileUnfrozen =
    allowed.kind === "allowed"
      ? { kind: "allowed", hash: allowed.submission.hash, ledger: allowed.submission.ledger }
      : { kind: allowed.kind, detail: json(allowed) };
  if (allowed.kind !== "allowed") {
    throw new Error(
      `an unfrozen account refused a valid transfer — cannot draw a freeze conclusion: ${json(allowed)}`,
    );
  }

  // ── 8. THE PANIC BUTTON ────────────────────────────────────────────────
  step("[8] panic button: freeze()");
  const frozen = await freezeGuard({ server, signer, guard });
  step(
    `    → ${frozen.kind}${
      frozen.kind === "submitted"
        ? ` tx ${frozen.hash} (ledger ${frozen.ledger})`
        : ` ${frozen.detail}`
    }`,
  );
  if (frozen.kind !== "submitted") throw new Error(`freeze did not land: ${frozen.kind}`);
  record.freeze = { hash: frozen.hash, ledger: frozen.ledger };

  // 8a. The contract's own view, re-read from the chain.
  const afterFreeze = await readStatus(server, guard, admin.publicKey());
  if (!afterFreeze.ok) throw new Error(`could not re-read status(): ${afterFreeze.error}`);
  step(
    `    status() re-read: admin_frozen=${afterFreeze.value.admin_frozen} heartbeat_expired=${afterFreeze.value.heartbeat_expired}`,
  );
  record.statusAfterFreeze = afterFreeze.value;
  if (!afterFreeze.value.admin_frozen) {
    throw new Error(
      "freeze was signed and included, but status() does not report admin_frozen — that is a failed freeze",
    );
  }

  // 8b. The decision path itself refuses.
  const checkFrozen = await readView<unknown>(guard, "check", transferArgs(10n), admin.publicKey());
  step(`    check() while frozen: ${json(checkFrozen.value ?? checkFrozen.error)}`);
  record.checkWhileFrozen = checkFrozen.value ?? checkFrozen.error;

  // 8c. The definitive test: __check_auth refuses a real agent transfer.
  step("    same transfer, account frozen → expect a __check_auth refusal");
  const blocked = await attemptTransfer();
  if (blocked.kind === "blocked") {
    step(
      `    → blocked, reason=${blocked.reason} (nothing broadcast, so no hash — by construction)`,
    );
    record.transferWhileFrozen = {
      kind: "blocked",
      reason: blocked.reason,
      detail: blocked.detail,
      diagnosticEvents: guardEventsFromDiagnostics(blocked.diagnosticEvents, guard),
    };
  } else {
    step(`    → UNEXPECTED ${blocked.kind}: ${json(blocked)}`);
    record.transferWhileFrozen = { kind: blocked.kind, detail: json(blocked) };
    throw new Error(
      `a frozen account did not refuse a transfer (${blocked.kind}) — the freeze is not effective`,
    );
  }

  // ── 9. reversal ────────────────────────────────────────────────────────
  step("[9] reversal: unfreeze()");
  const unfrozen = await unfreezeGuard({ server, signer, guard });
  step(
    `    → ${unfrozen.kind}${
      unfrozen.kind === "submitted"
        ? ` tx ${unfrozen.hash} (ledger ${unfrozen.ledger})`
        : ` ${unfrozen.detail}`
    }`,
  );
  if (unfrozen.kind !== "submitted") throw new Error(`unfreeze did not land: ${unfrozen.kind}`);
  record.unfreeze = { hash: unfrozen.hash, ledger: unfrozen.ledger };

  const afterUnfreeze = await readStatus(server, guard, admin.publicKey());
  if (!afterUnfreeze.ok)
    throw new Error(`could not re-read status() after unfreeze: ${afterUnfreeze.error}`);
  step(`    status() re-read: admin_frozen=${afterUnfreeze.value.admin_frozen}`);
  record.statusAfterUnfreeze = afterUnfreeze.value;
  if (afterUnfreeze.value.admin_frozen) {
    throw new Error("unfreeze landed but status() still reports admin_frozen");
  }

  step("    same transfer again → expect it to pass");
  const reAllowed = await attemptTransfer();
  step(
    `    → ${reAllowed.kind}${
      reAllowed.kind === "allowed"
        ? ` tx ${reAllowed.submission.hash} (ledger ${reAllowed.submission.ledger})`
        : ` ${json(reAllowed)}`
    }`,
  );
  record.transferAfterUnfreeze =
    reAllowed.kind === "allowed"
      ? { kind: "allowed", hash: reAllowed.submission.hash, ledger: reAllowed.submission.ledger }
      : { kind: reAllowed.kind, detail: json(reAllowed) };
  if (reAllowed.kind !== "allowed") {
    throw new Error(`unfreeze did not restore the account: ${json(reAllowed)}`);
  }

  // ── 10. telemetry over the real emitted events ─────────────────────────
  step("[10] telemetry feed over the events those writes emitted");
  const feed = new GuardFeed(server, guard, NETWORK.rpcUrl);
  const latest = await server.getLatestLedger();
  feed.resetFrom(latest.sequence - 300);
  const seen: Array<{
    kind: string;
    source: string;
    ledger: number | null;
    tx: string | null;
    decision: unknown;
  }> = [];
  for (let page = 0; page < 4; page++) {
    const result = await feed.pollOnce(50);
    for (const event of result.events) {
      seen.push({
        kind: event.kind,
        source: event.source,
        ledger: event.ledger,
        tx: event.transactionHash,
        decision: event.decision,
      });
    }
    if (result.events.length === 0 && result.cursor) break;
  }
  const kinds = [...new Set(seen.map((event) => event.kind))];
  step(`    decoded ${seen.length} event(s): ${kinds.join(", ")}`);
  record.telemetry = {
    eventCount: seen.length,
    kinds,
    sample: seen.slice(0, 12),
  };
  const lifecycle = ["initialized", "policy_set", "frozen", "unfrozen"];
  const missing = lifecycle.filter((kind) => !kinds.includes(kind));
  if (missing.length > 0) {
    // Not fatal — the scan window is bounded — but it must be visible rather
    // than quietly reported as a full set.
    step(`    NOTE: lifecycle events not seen in this scan window: ${missing.join(", ")}`);
  }
  record.telemetryMissingFromScan = missing;

  // ── 11. final state ────────────────────────────────────────────────────
  const finalStatus = await readStatus(server, guard, admin.publicKey());
  record.finalStatus = finalStatus.ok ? finalStatus.value : { error: finalStatus.error };
  record.passed = true;

  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, `${json(record)}\n`);

  step("");
  step("Phase 3 proof complete.");
  step(`  guard           ${guard}`);
  step(`  token           ${token}`);
  step(`  artifact pin    ${PHASE1_ARTIFACT.wasmHash}`);
  step(`  freeze          ${(record.freeze as { hash: string }).hash}`);
  step(`  unfreeze        ${(record.unfreeze as { hash: string }).hash}`);
  step(`  frozen refusal  ${(record.transferWhileFrozen as { reason?: string }).reason}`);
  step(`  evidence        ${FIXTURE_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
