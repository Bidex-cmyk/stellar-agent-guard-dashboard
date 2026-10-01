# Runbook — Emergency Freeze & Security Incident Response

**Audience:** the operator holding the guard account's **admin** key.
**Applies to:** any `stellar-agent-guard` smart account whose on-chain state this
dashboard reads and writes.
**Related:** [Dual-freeze semantics](../concepts/dual-freeze-semantics.md) ·
[Panic button & freeze](../screens/panic-freeze.md) ·
[Enforcement scope](../enforcement-scope.md) ·
[Routine policy updates](./policy-updates.md)

> **Read this before an incident, not during one.** Everything here is designed to
> be followed under stress. If you are in the middle of an incident, jump straight
> to [Immediate action](#immediate-action-the-first-five-minutes).

---

## 1. The one thing to understand first

Stellar Agent Guard has **two independent freeze mechanisms**, and they are not
the same event:

| Mechanism                        | On-chain flag                    | Who triggers it                                                               | How it clears                                 |
| -------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| **Admin freeze**                 | `admin_frozen = true`            | The operator's panic button (wallet-signed `freeze()`)                        | Admin-signed `unfreeze()`                     |
| **Dead-man-switch (DMS) freeze** | derived from `heartbeat_expired` | The contract, automatically, when the agent misses its heartbeat grace window | Admin `unfreeze()` **or** agent `heartbeat()` |

The UI renders these as separate states on purpose. A DMS freeze is _not_ an
intrusion — it is the switch working as configured, usually because the agent
runtime stopped or lost its key. An admin freeze is always a deliberate human
action.

**Both stop the agent.** After either, `__check_auth` refuses every call the
account would make, so the agent cannot move funds or call protocols. That is the
whole point: freeze first, investigate second.

---

## 2. Incident classification

Classify before you act. The class sets the timeline, not the other way around.

| Class                                         | Example                                                                                                                        | Response target                                                                                          | Freeze?                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| **SEV-1 — Active loss / key compromise**      | Funds leaving the account to an unknown recipient; admin or agent key known or suspected leaked; `__check_auth` being bypassed | Freeze **immediately**, target < 2 minutes                                                               | **Yes, now**              |
| **SEV-2 — Suspected compromise, no loss yet** | Unusual `event_auth_checked` blocks from a source you did not deploy; unknown device holds a copy of the agent key             | Freeze, target < 5 minutes                                                                               | **Yes, then investigate** |
| **SEV-3 — Abnormal agent behaviour**          | Agent looping, calling unexpected protocols, spending near the cap, heartbeat late                                             | Contain by tightening the policy ([policy runbook](./policy-updates.md)), freeze if the cause is unknown | Often                     |
| **SEV-4 — DMS freeze, no intrusion**          | `heartbeat_expired = true` after a deploy or a restart                                                                         | No emergency; restore the agent or unfreeze                                                              | No                        |
| **SEV-5 — Suspicious but benign**             | Telemetry you cannot explain, no state change                                                                                  | Watch the feed, do not act                                                                               | No                        |

Decision rule: **if you cannot name the cause of an unexplained state change,
freeze.** An unnecessary freeze costs the agent uptime. A delayed freeze costs
funds. The freeze is reversible; a drained account is not.

---

## 3. Response timeline

| Clock            | Action                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| **T+0**          | Notice the signal. Do not refresh repeatedly — read the chain once and write down what `status()` returned. |
| **T+0..2 min**   | Classify (section 2). Open the dashboard, connect the **admin** wallet.                                     |
| **T+2..5 min**   | Execute the freeze (section 4). The write is wallet-signed; nothing else can do it for you.                 |
| **T+5..15 min**  | **Verify on chain** (section 5). The UI claiming success is not evidence.                                   |
| **T+15..60 min** | Preserve evidence (section 7): telemetry, transaction hashes, timestamps.                                   |
| **T+1h..48h**    | Rotate keys if compromise is plausible (section 8).                                                         |
| **T+48h+**       | Root-cause analysis and the unfreeze checklist (sections 9–10).                                             |

Larger windows are acceptable for lower severities. **Never skip T+5 verification**,
even when the freeze looks successful.

---

## 4. The two-step confirmation ritual

The freeze is irreversible without a second signature, so the console makes you
say so explicitly. This is deliberate friction, not a bug.

1. Open the console (`/`) with the admin wallet connected and on **Testnet**.
2. Confirm the guard address in the selector is the account you mean to freeze.
   Freezing the wrong instance halts a different agent and leaves the real one
   running.
3. Under **Emergency**, click **Freeze this account**.
4. A modal opens:
   - It **moves keyboard focus into the dialog**, keeps `Tab`/`Shift+Tab` cycling
     inside it, and closes on `Escape` — and on close focus returns to the button
     that opened it. This exists so the confirmation is operable without a mouse
     during an incident.
   - Tick **"I understand this halts the agent's spending…"** (`#ack-freeze`). The
     **Sign freeze** button stays disabled until you do.
5. Click **Sign freeze**. Freighter prompts for signature (up to two prompts: one
   for the authorization entry, one for the transaction envelope).
6. The panel re-reads the contract's own `status()` and reports the result. A
   write that was signed and included but did **not** flip the flag is reported as
   **"NOT confirmed"**, not as a success.

The same panel exposes **Unfreeze**, enabled only when the chain reports the
account is frozen.

> **Do not trust the modal's own claim.** Step 6 is the console verifying itself;
> section 5 is you verifying the console.

### Multi-tab operators

If you keep the console open on several screens, a confirmed freeze is broadcast to
every other tab, which re-reads the chain automatically. Tabs you have not looked
at should therefore show the frozen state without a manual refresh. If one does
not, treat it as a stale view and reload it — never as evidence the freeze failed.

---

## 5. Verify the freeze on chain (required)

The dashboard's verification is convenient, not authoritative. Confirm with the
contract itself.

### 5a. With this repo's reader (read-only, no signing)

```bash
npm run inspect -- --guard C…YOUR_GUARD
```

Expected output includes:

```
admin_frozen        true
heartbeat_expired   false   # or true, for a DMS freeze
```

`npm run inspect -- --guard C… --json` gives the same thing machine-readable for a
ticket or an incident log.

### 5b. With the Soroban / Stellar CLI

Use the [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools)
(`stellar`; older installs expose the same commands as `soroban`). `status()` takes
no arguments:

```bash
export GUARD=C…YOUR_GUARD
export ADMIN_IDENTITY=your-cli-identity        # a `stellar keys` entry, never a raw secret

stellar contract invoke \
  --id "$GUARD" \
  --source "$ADMIN_IDENTITY" \
  --network testnet \
  -- status
```

Read `admin_frozen` (and, separately, whether `heartbeat_expired` is true). A
freeze is only real when the contract says so.

### 5c. Confirm the agent is actually blocked

The strongest evidence is a refused write. Trigger one transfer the agent would
normally be allowed to make and confirm it is **refused before broadcast**, with
reason `admin_frozen` and **zero fees spent**. The dashboard surfaces this as a
`blocked` row labelled **diagnostic** in the telemetry feed.

This is the pre-flight path working: nothing was sent, nothing was paid, and the
account refused. See [Diagnostic simulation ADR](../adr/002-diagnostic-simulation-for-rejections.md).

---

## 6. Quick-reference CLI fallback (web UI unavailable)

Use these when Freighter is unavailable, the browser is compromised, or the
dashboard cannot be trusted/loaded. All of them require the **admin** identity.

```bash
export GUARD=C…YOUR_GUARD
export ADMIN_IDENTITY=your-cli-identity

# --- READ (safe, non-mutating) ---------------------------------------------
# Full state: admin_frozen, heartbeat_expired, last_heartbeat, now
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- status

# Installed policy (default-deny if none)
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- policy

# Current rolling spend window
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- window

# --- WRITE (mutating, admin-signed) ----------------------------------------
# Emergency freeze — the panic button, without the browser
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- freeze

# Reverse a freeze (admin freeze OR dead-man-switch freeze)
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- unfreeze

# Back to default-deny: revoke the installed policy
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- revoke_policy

# Rotate the registered agent key: 32 raw Ed25519 bytes, hex-encoded.
# Run `stellar contract invoke --id "$GUARD" --network testnet -- --help`
# to print the exact argument name the deployed ABI expects.
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- \
  rotate_agent_key --new_agent_pubkey 0x<64-hex-chars>
```

Notes:

- The source identity is a `stellar keys` entry backed by a local secret. In a
  SEV-1 where a key may be compromised, **prefer the dashboard with a hardware- or
  Freighter-held admin key**, and rotate after.
- A freeze executed here is not broadcast to other browser tabs (there is no tab).
  Re-read `status()` in each open console after using the CLI.
- Verify the guard address character-for-character before any write. There is no
  undo, only `unfreeze()`.

---

## 7. Preserve evidence before you investigate

Freezing stops the bleeding; it does not explain it. Collect, in this order:

1. **Transaction hashes** from the console's transaction history (the `TxHistory`
   panel records every write this console made, with fee and timestamps). Export
   CSV/JSON from the panel — it is a local record and is lost if the browser
   profile is cleared.
2. **On-chain state**: run the read commands in section 6 and paste the JSON into
   the incident log. Include `last_heartbeat` and `now` — the DMS timeline is
   derived from them.
3. **Telemetry**: the event feed is cursor-based polling of `event_auth_checked`
   topics. Capture the window from _before_ the first anomaly. Ledger-sourced rows
   are settled history; **diagnostic** rows are local to the tab that produced them
   and are not on the ledger — export or screenshot them before closing that tab.
4. **The policy that was installed at the time**: `stellar contract invoke … -- policy`.
5. **Artifact identity**: confirm the instance still runs the pinned Phase 1
   artifact. `npm run inspect` prints `is Phase 1 artifact`. If it reads `false`,
   you are not looking at the contract this dashboard deploys — escalate.

Write a timestamp for every artifact. The sequence of _when you knew what_ is part
of the record.

---

## 8. Key rotation after suspected compromise

Assume compromise until proven otherwise if any of these hold: the agent key was
stored anywhere it should not have been; the admin wallet was used on a machine
you do not control; an unknown transaction exists in the account's history.

**Order matters: freeze → rotate the agent key → then decide about the admin key.**

### 8a. Rotate the agent key

The agent's key is a raw Ed25519 public key registered to the smart account.
Rotation is admin-authorized:

```bash
# 1. Generate the replacement OFF the compromised machine.
stellar keys generate agent-2 --network testnet

# 2. Read its raw Ed25519 public key, hex-encoded (32 bytes).
#    The dashboard's /configure deploy panel also shows how the key is expected.
stellar keys address agent-2

# 3. Rotate on chain, signed by the admin identity.
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- \
  rotate_agent_key --new_agent_pubkey 0x<64-hex-chars>
```

After rotation the **old agent key no longer authorizes anything**, even while the
account is frozen. Update the agent runtime to the new key only after the account
is safe.

### 8b. Admin key compromise

The contract has one admin. If the _admin_ key is compromised, freeze and treat the
account as hostile:

1. Freeze immediately (section 4) — a compromised admin can `unfreeze()`, so this
   is containment, not a fix.
2. Do **not** reuse the compromised admin key to unfreeze.
3. Because the contract's admin is fixed at `initialize`, the durable remedy is to
   **deploy a fresh guard account** from the pinned, artifact-verified bytecode
   (the `/configure` deploy panel), initialize it with an uncompromised admin, move
   the agent's assets to the new account, and abandon the old one frozen.
4. Record the old account address in the incident log as permanently retired.

---

## 9. Root-cause analysis

Do this after the account is stable, within 48 hours.

1. **Reconstruct the timeline** from the evidence in section 7: first anomaly,
   first freeze attempt, first confirmed freeze.
2. **Classify the failure** — key compromise, agent runtime bug, prompt injection
   into the agent, misconfiguration, or contract-level issue.
3. **Check what the policy allowed.** Which rule should have blocked the behaviour
   and did not? Cross-check against the
   [enforcement scope](../enforcement-scope.md): per-call amount and recipient
   limits apply to SAC transfers (`transfer`/`transfer_from`); arbitrary protocol
   calls are gated only by protocol/function allowlists, window and pause state.
   If the incident exploited that boundary, that is an expected limitation, not a
   contract bug — and it is a signal to tighten the protocol allowlist.
4. **Decide the durable fix**: a narrower protocol allowlist, a lower per-transaction
   or rolling cap, a shorter DMS grace window, key storage changes, or a contract
   change tracked in `stellar-agent-guard-contracts`.
5. **Write the policy change down** and apply it through the
   [policy updates runbook](./policy-updates.md) — not ad hoc.
6. **File the public-facing outcome** as a GitHub issue on this repo if the fix is a
   dashboard change (telemetry, validation, UI clarity). Do not include secrets.

---

## 10. Unfreeze checklist

`unfreeze()` clears the admin freeze **and restarts the heartbeat clock**, so it is
also the way back from a DMS freeze. Do not unfreeze until every box is ticked.

- [ ] Root cause is identified, or the agent has been stopped entirely.
- [ ] The agent runtime holds only a **rotated** key, and the old key is destroyed.
- [ ] The installed policy has been reviewed and tightened where the incident
      showed it was too permissive.
- [ ] Recipient and protocol allowlists are exactly what you intend; recall that an
      empty recipient allowlist with the allowlist enabled refuses **every**
      transfer.
- [ ] Caps are set to values you are willing to lose in a single window.
- [ ] The DMS grace window is realistic for the agent's heartbeat cadence.
- [ ] A monitor is watching the telemetry feed, and someone is on call.
- [ ] The incident log is written up and shared with the maintainers.

Then:

```bash
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- unfreeze
```

Or, in the console, click **Unfreeze**. Either way, immediately re-verify with
`status()` that `admin_frozen = false`, and confirm a normal agent call is
**allowed** again — that is the same end-to-end check the Phase 3 proof records in
[`tests/fixtures/phase3-proof.json`](../../tests/fixtures/phase3-proof.json).

If the account was compromised at the admin level, do **not** unfreeze it; retire it
per section 8b.

---

## 11. Escalation

- **Dashboard/telemetry/UI problems:** open a GitHub issue on this repository with
  the freeze verification output and the reproduction steps. Redact addresses if
  they are mainnet.
- **Contract behaviour:** `stellar-agent-guard-contracts` — the contract's admin
  and policy semantics live there.
- **SDK / agent runtime:** `stellar-agent-guard-sdk`.
- **Security disclosure:** follow the process in the contracts repository's
  `SECURITY.md` (Telegram, the Stellar ecosystem norm). Do not disclose a live
  exploit in a public issue.

> ⚠️ This is unaudited security tooling that gates real fund access. Do not deploy
> to mainnet without an independent audit.
