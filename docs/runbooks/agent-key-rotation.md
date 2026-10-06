# Runbook — Agent Key Rotation & Non-Custodial Security

**Audience:** the operator holding the guard account's **admin** key.
**Applies to:** any `stellar-agent-guard` smart account whose agent key needs replacing —
scheduled hygiene or suspected compromise.
**Related:** [Emergency freeze runbook](./emergency-freeze.md) ·
[ADR 003 — Non-custodial wallet model](../adr/003-non-custodial-wallet-model.md) ·
[Dual-freeze semantics](../concepts/dual-freeze-semantics.md) ·
[Client-side Freighter architecture](../concepts/client-side-freighter-architecture.md)

> **Read the security model in section 1 before touching anything.** The procedure itself is four
> commands long; the mistakes it guards against are all misunderstandings about who can do what to
> whom.

---

## 1. The security model: two keys, two jobs, one hard boundary

A guard account has exactly two principals, and their powers are disjoint **by design**:

|                                     | **Admin key**                                                                                          | **Agent key**                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Lives in**                        | The operator's wallet (Freighter; hardware for high-value guards)                                      | The agent runtime, via the SDK                                                   |
| **Is**                              | A plain Stellar account (`G…`) named at `initialize`                                                   | A raw Ed25519 public key registered on the smart account                         |
| **Can**                             | `set_policy`, `revoke_policy`, `freeze`, `unfreeze`, `rotate_agent_key`, deploy/initialize             | Authorize the account's own outbound calls through `__check_auth`, `heartbeat()` |
| **Cannot**                          | Move funds, forge a heartbeat, or authenticate as the agent                                            | Change the policy, freeze/unfreeze, rotate itself, or call any admin function    |
| **Loses custody of the other key?** | **Never** — rotation replaces the registered agent _public_ key; the admin never sees any agent secret | **Never** — the agent runtime never holds, nor ever needed, the admin key        |

This is the trust boundary in one sentence: **the admin key controls _which_ agent key the account
will honour, but can never _be_ the agent key.** The contract enforces the second half directly —
admin-only functions reject agent-signed calls (`self_function_not_allowed` class), and
`heartbeat()` requires the guard's own authorization, so no admin action can fake agent liveness.
`SPEC.md` §5 states it as "`rotate_agent_key`… the admin can replace the key the account
authenticates but can never authenticate as the agent."

### Why `rotate_agent_key` is an admin action

The agent key is the credential that authorizes spending. If the _agent_ could rotate it, then any
party holding the agent key — including a runtime that has been prompt-injected or whose key has
leaked, which is exactly when rotation is needed — could replace it with its own fresh key and
launder the compromise. Rotation therefore requires the **admin** signature: the human who owns the
account is the only party who may decide which key the account trusts next. The agent key can
authorize the account's payments under the installed policy; it cannot redefine what authorizes
payments.

### How the smart account updates its authentication identity

A guard is a Soroban **custom account**: the "account address" _is_ a contract, and the host routes
every authorization that contract makes through its `__check_auth`. The registered agent key lives
in the contract's own storage. `rotate_agent_key(new_agent_pubkey)` — admin-authorized — overwrites
that single storage entry with the new 32-byte Ed25519 public key:

- The account's contract address **does not change**. Balances, trustlines, allowlisted recipients,
  and any external references to the guard keep pointing at the same `C…` address.
- From the next ledger onward, the host asks the contract to verify agent signatures against the
  **new** key. The old key does not "expire" — it simply stops being the registered identity the
  moment the rotation transaction is included, and verifies nothing from then on.
- Everything else about the account is untouched: the installed policy, freeze state, the rolling
  spend window, the dead-man-switch clock, and the admin identity all persist.

### How custody is disproven — the non-custodial proof

"The admin key never has custody over agent credentials" is checkable at every layer, not asserted:

1. **In the dashboard's code.** The admin path (`lib/guard/guardOps.ts`) constructs
   `rotate_agent_key` with one argument: `xdr.ScVal.scvBytes(pubkey)` — the **public** key's 32
   bytes, hex-decoded from the string the operator pasted. There is no field in the call, the
   interface, or the wallet prompt for a secret. A signature from the admin over a _public_ key
   cannot conjure the corresponding private key.
2. **In the signing model.** Per [ADR 003](../adr/003-non-custodial-wallet-model.md), the admin's
   signature is produced inside their wallet over a payload the wallet displays; the dashboard never
   handles admin secret material either. The only secret that ever exists in connection with a
   rotation is the _new agent's_ private key — generated off-dashboard (section 3, step 1), held
   only by the agent runtime, and never passed to this console or the contract.
3. **In the contract's storage.** Only a public key is ever written on chain. At no point in the
   system — repo, build artifact, chain state, or event payload — does agent secret material
   appear. The counterfactual is testable: `grep` this repo for the new agent's secret after a
   rotation; it is not there, because the dashboard's interface cannot accept it.

---

## 2. When to rotate

| Trigger                                                 | Urgency                     | Sequence                                                                                                                                                                                           |
| ------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled hygiene (e.g. quarterly)                      | Routine                     | section 3, unhurried; freeze not required                                                                                                                                                          |
| Agent key was on a machine that is being decommissioned | Routine, but before wiping  | section 3                                                                                                                                                                                          |
| The runtime behaved abnormally; cause unknown           | **Suspected compromise**    | **freeze first** ([emergency runbook](./emergency-freeze.md)), then section 3                                                                                                                      |
| The agent key is known or strongly suspected leaked     | **SEV-1**                   | **freeze immediately**, then section 3                                                                                                                                                             |
| Admin key is compromised                                | **SEV-1, different remedy** | Do **not** use this runbook — the admin cannot rotate itself. Follow the [emergency runbook §8b](./emergency-freeze.md#8-key-rotation-after-suspected-compromise): freeze, then retire the account |

**Order when compromise is suspected: freeze → rotate → investigate.** Rotation with the account
open lets a leaked key keep transacting (under the old policy) up to the ledger in which the new
key lands; a freeze closes that window at the cost of nothing, since unfreeze restarts cleanly.
Do not unfreeze until section 6's verification passes.

---

## 3. The procedure — four steps, in this order

Prerequisites: the admin wallet connected on **Testnet** (or your target network), and a terminal
with the [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools) available for the
key generation and verification steps. Every command is safe to re-run; step 4 is the only mutating
one.

> The console deliberately does **not** wire a `rotate_agent_key` UI (`SPEC.md` §5: the panel is
> "not wired — holds a key-management decision this console has no UI to make safely"). New-key
> generation, custody handover and out-of-band confirmation are human steps; a form field asking the
> operator to paste a fresh public key would invite pasting the _secret_ by mistake, and the CLI
> path (below) is auditable. Until that decision is made, use the CLI fallback in
> [emergency-freeze §6](./emergency-freeze.md#6-quick-reference-cli-fallback-web-ui-unavailable)
> for step 4 — the dashboard's `rotateAgentKey` library path exists and is unit-tested
> (`tests/unit/rotateAgentKey.test.ts`), but it has no panel.

### Step 1 — Generate the new agent key **off the current runtime**

Generate on a machine (or into a wallet) that is not the possibly-compromised runtime:

```bash
stellar keys generate agent-2 --network testnet
stellar keys address agent-2        # the G… address — safe to handle
```

Extract the **raw public** key as 64 hex characters (32 Ed25519 bytes). `stellar keys address`
prints the `G…` form; the contract wants the raw bytes — the SDK and the dashboard's
`rotateAgentKey` both accept/expect the hex encoding of those bytes (the CLI's
`--new_agent_pubkey 0x…` argument takes the same). Note which of the two encodings your toolchain
wants before step 4; the contract rejects anything that is not exactly 32 bytes, and the dashboard's
path refuses it pre-broadcast with "the new agent public key must be 32 raw Ed25519 bytes".

- The corresponding **secret** goes directly to the agent runtime's secret store. Never through
  this dashboard, never in a ticket, never in a shell history on a compromised machine.
- Verify separation of duties: the new agent key must not be the admin's key
  (`lib/guard/initValidator.ts` enforces this at deploy time for the same reason).

### Step 2 — Update the agent runtime **before** rotating on chain

Sequence the swap so the runtime is never the missing party:

1. Configure the runtime to load the **new** key for signing `SorobanAuthorizationEntry`s.
2. Keep the **old** key loaded but _unused_ until the rotation lands. If the runtime signs anything
   with the old key after the rotation ledger, the host refuses it (`unauthorized`) — those
   signatures are harmless but noisy, so switch over cleanly.
3. Restart the runtime and watch its first heartbeat cycle. With a policy whose dead-man grace is
   comfortably above the restart time, the swap window is safe; if the runtime will be down longer
   than the grace, expect a DMS freeze and plan the admin `unfreeze()` that follows it
   ([dual-freeze semantics](../concepts/dual-freeze-semantics.md)).

**Rollout order rationale:** if the runtime is switched first and the chain second, there is a short
window where the runtime holds a key the account does not yet honour — but the failure mode is
_blocked agent transactions_ (no fund risk, `unauthorized` in the telemetry feed), whereas the
reverse order leaves the runtime unable to sign at all while the account already expects a key
nobody has. Both are recoverable; the first is quieter and needs no admin action.

### Step 3 — Submit `rotate_agent_key` (admin-signed)

Via the Stellar CLI, with the **admin** identity:

```bash
export GUARD=C…YOUR_GUARD
export ADMIN_IDENTITY=your-cli-identity

stellar contract invoke \
  --id "$GUARD" \
  --source "$ADMIN_IDENTITY" \
  --network testnet \
  -- rotate_agent_key --new_agent_pubkey 0x<64-hex-chars>
```

(SDK-side, this is the same call the dashboard's `rotateAgentKey` builds: an
`invokeContractFunction` operation with one `Bytes` argument, going through the
simulate → sign → enforce → submit pipeline — the enforced simulation runs the real `__check_auth`
before anything is broadcast, so a wrong-length key or a non-admin signer is refused with zero fees
and no hash. See [ADR 003](../adr/003-non-custodial-wallet-model.md) for the flow.)

Record in the ops log: the new key's **public** fingerprint, the rotation transaction hash, the
ledger, and who authorized it. Do **not** log the new secret.

### Step 4 — Verify the new authentication end-to-end

The rotation is real when the account _behaves_ differently, not when a transaction lands:

1. **On-chain confirmation.** The transaction result shows success. (The contract has no dedicated
   read for "current agent key" — it is treated as a secret-adjacent identity, and its rotation is
   observable only through behaviour. That is deliberate.)
2. **The new key authorizes.** Trigger one benign agent action the policy allows (a small SAC
   transfer to an allowlisted recipient) and confirm it is **allowed** — signed by the _new_ agent
   key. This is the same end-to-end check the Phase 3 proof records in
   [`tests/fixtures/phase3-proof.json`](../../tests/fixtures/phase3-proof.json).
3. **The old key is dead.** Attempt one agent-authorized call signed with the **old** key and
   confirm it is refused before broadcast with `unauthorized` — _"The presented signature did not
   verify against the account's registered agent key."_ Refused calls have no transaction hash by
   construction ([ADR 002](../adr/002-diagnostic-simulation-for-rejections.md)); the evidence is the
   contract's own blocked-diagnostic, which the telemetry feed surfaces as a `diagnostic` row.
4. **Telemetry agrees.** The feed shows the allowed decision from the new key and, if you ran step
   3's negative test, the `blocked, unauthorized` diagnostic from the old one.

Only after 1–4 pass is the rotation proven.

---

## 4. Decommissioning the old agent keypair

Verification proves the old key no longer _works_; decommissioning ensures it also no longer
_exists_ anywhere it could be revived from. Work through the list in order:

- [ ] **Runtime secret store purged** — the old key removed from the runtime's env/secret store,
      not merely overwritten; config references updated so a rollback does not silently resurrect
      it.
- [ ] **Config and manifests scrubbed** — deployment configs, CI variables, container images built
      with the key baked in, and any `.env` copies in worktrees. An image layer is a backup you
      forgot you made.
- [ ] **Shell history and notebooks cleaned** on machines that were used for generation; if any of
      those machines is a compromise suspect, treat the old key as burned regardless (it is already
      dead on chain — this step is about hygiene, not security).
- [ ] **Backups and snapshot secrets revoked** — the old key must not be restorable from any
      secret-manager version history.
- [ ] **The machine that held it, if compromised, is rebuilt** or the key material on it is
      securely erased — under the assumption that a persisted copy may have been exfiltrated.
- [ ] **Ops log updated** with the key's retirement date and the reason. Public fingerprints only.

A decommissioned key that survives in a forgotten backup is not a working credential (the account
will not honour it), but it is still a _correlation_ leak: anything signed with it identifies the
same agent. Retire means gone.

## 5. Anti-patterns

- **Rotating before freezing on suspected compromise.** The leaked key remains usable until the
  rotation ledger lands; freeze first — it is one transaction and it stops everything.
- **Generating the new key on the possibly-compromised machine.** The rotation exists to escape the
  compromise; a new key generated inside the blast radius inherits it.
- **Pasting the new key's secret into any dashboard field, ticket, or chat.** The contract wants 32
  _public_ bytes; if you are typing 100+ characters starting with `S`, stop.
- **Deleting the old key before verifying.** If verification (section 3, step 4) fails, the old
  key's removal from the runtime is your rollback for _its_ half; on-chain you cannot roll back a
  rotation, but you can rotate again — to a key you still possess.
- **Rotating "to be safe" with a DMS grace you have not checked.** If the runtime restart in step 2
  outlasts the grace window, the account will DMS-freeze mid-procedure. Plan the swap inside the
  grace, or accept and pre-plan the unfreeze.
- **Reusing the old agent key for a different account.** Its signatures correlate across whatever
  it authenticates; compromised elsewhere, it is compromised here.

## 6. Verification recap (the whole runbook in one box)

```text
1. generate new key off-runtime        (secret → runtime only)
2. runtime loads new key, old kept     (agent blocked ≠ funds at risk)
3. admin signs rotate_agent_key        (public key only, enforced pre-flight)
4. verify: new allowed / old refused   (unauthorized, no hash, no fee)
5. decommission old key everywhere     (stores, configs, images, backups)
```

If any verification step fails: freeze the account, leave the runtime on whichever key the chain
currently honours (per the telemetry), and re-run from step 1 with a fresh key. The freeze is
reversible; a wrong key honouring is not.

---

## Escalation

- **Dashboard/telemetry/UI problems during rotation:** open a GitHub issue on this repository with
  the CLI verification output. Redact addresses if they are mainnet.
- **Contract behaviour** (rotation accepted but the old key still verifies, or the new key is
  refused after success): `stellar-agent-guard-contracts` — the auth-identity semantics live there.
- **SDK / agent runtime** (step 2 of the procedure): `stellar-agent-guard-sdk`.
- **Live suspected exploit:** do not open a public issue; follow the security disclosure process in
  the contracts repository's `SECURITY.md`.

> ⚠️ This is unaudited security tooling that gates real fund access. Do not deploy to mainnet
> without an independent audit.
