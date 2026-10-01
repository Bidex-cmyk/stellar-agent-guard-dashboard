# Runbook — Routine Policy Updates and Audit Checklist

**Audience:** the operator holding the guard account's **admin** key.
**Applies to:** changing the spending policy installed on a live
`stellar-agent-guard` smart account — caps, allowlists, execution windows, pause
state, dead-man switch.
**Related:** [Policy configurator](../screens/policy-configurator.md) ·
[Enforcement scope](../enforcement-scope.md) ·
[Emergency freeze runbook](./emergency-freeze.md)

> A policy update is a **live change to the rules that gate real funds**. Treat it
> with the same discipline as the emergency freeze: decide, stage, validate,
> submit, then verify on chain. Never edit a policy during an active incident —
> freeze first, then change the rules ([emergency freeze](./emergency-freeze.md)).

---

## 1. What `set_policy` actually does

Installing a policy is not an in-place edit. `set_policy` replaces the whole
configuration and has two consequences you must account for:

1. **The rolling spend window resets.** The accumulated rolling spend is cleared.
   An agent that had already spent `N` units against a `2N` window cap starts again
   from zero. If you are tightening a cap _because_ spending is high, resetting the
   window hands the agent a fresh full allowance — size the new cap for that, not
   for the current spend.
2. **The dead-man-switch clock restarts.** `last_heartbeat` is reset, so the full
   grace window begins again. An agent that was seconds from a DMS freeze gets the
   whole window back. If the agent runtime is not running, do not install a policy
   expecting a DMS freeze soon — it will not fire until the new grace window
   elapses.

Both are shown in the form: _"Installing a policy resets the rolling window and
restarts the dead-man-switch clock, so a freshly installed policy always starts
with full grace."_

`revoke_policy` is the hard reset: the account keeps no policy and **refuses every
call** (default deny). It is a rollback tool, not a neutral state.

---

## 2. Before you start

- [ ] You are on the **right guard**. Confirm the address in the selector matches
      the account you mean to change, character for character. Changing another
      instance's policy silently loosens or breaks a different agent.
- [ ] The admin wallet is connected, on **Testnet**, and network-checked by the
      console. A signature for the wrong network passphrase cannot authorize a
      call here, and the console refuses at connect time rather than submitting.
- [ ] The agent is in a state where a transient refusal is acceptable, or it is
      stopped. Between `set_policy` landing and its full effect, the agent's calls
      are judged by whichever configuration is live at that instant.
- [ ] You have the **current** policy captured (section 3). You cannot roll back to
      something you did not record.
- [ ] No freeze is active, or you accept that the policy change is being staged for
      later.

---

## 3. Capture the current policy first (rollback baseline)

Do this **before** touching the form. You need both a human-readable summary and a
machine-readable copy.

**In the console:** the Overview screen's **"Policy in force"** card shows the
installed policy (`describePolicy`). Screenshot it. The transaction history panel
records the `set_policy` transaction hash and timestamp of the last install.

**From the chain:**

```bash
export GUARD=C…YOUR_GUARD
export ADMIN_IDENTITY=your-cli-identity

# The installed policy, as the contract returns it.
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- policy

# And the state around it, useful for the rollback decision.
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- status
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- window
```

Save the outputs to the change ticket. This is your rollback baseline and your audit
record.

---

## 4. Stage the update in the form (`/configure`)

Open **`/configure`**. The form seeds itself from the **currently installed policy**,
not from an empty template, so every edit is a deliberate change from what is live.
Until you type, the fields show the installed values; your first keystroke takes
over.

Field by field:

| Field                               | Meaning                                                                       | Notes                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Per-transaction cap**             | Largest single SAC transfer allowed                                           | Blank = no per-transaction cap. Whole units only.                                           |
| **Rolling-window cap**              | Total spend allowed inside a genuinely rolling window                         | Blank = no rolling cap.                                                                     |
| **Rolling-window length (seconds)** | How far back the rolling sum looks                                            | Must be non-zero whenever a rolling cap is set.                                             |
| **Dead-man grace (seconds)**        | Auto-freeze if the agent has not heartbeated within this many seconds         | Blank = DMS off.                                                                            |
| **Active from / until**             | Unix seconds; restricts execution to an interval                              | Blank both for unrestricted. `until` must be later than `from`.                             |
| **Assets**                          | SAC token contracts, one per line                                             | Transfers of these tokens get **full recipient and amount enforcement**.                    |
| **Per-asset cap overrides**         | Bulk-edit asset addresses and positive stroop caps; import/export CSV or JSON | Imported rows are **merged by contract address**; the badge shows what each import changed. |
| **Recipients**                      | One address per line                                                          | With the allowlist on, a transfer to an unlisted address is refused.                        |
| **Allow any recipient**             | Turns the recipient allowlist off                                             | Caps still apply.                                                                           |
| **Protocols**                       | `C…`, or `C…:swap,deposit` for a per-function allowlist                       | One per line. No colon = any function on that contract.                                     |
| **Start paused**                    | Installs the policy but refuses every call until resumed                      | The safe way to stage a policy change.                                                      |

Two behaviours worth knowing:

- **`Load installed`** discards your edits and re-reads the chain, so you can start
  over from what is actually live.
- **`Clear form`** empties every field. It does **not** uninstall the policy; it
  just gives you a blank draft. Do not confuse the two.

### The diff surface

There is no separate side-by-side diff view. The comparison is:

1. **The form's `Review` line** — a one-line human summary of the **draft**
   (`describeDraft`), e.g. `per-transaction cap 1000, rolling cap 150 per 86400s ·
2 allowlisted recipient(s) · 1 protocol(s) · 1 asset · active · dead-man grace 3600s`.
2. **The Overview screen's `Policy in force` line** — the same summary shape for what
   is **installed on chain**.

Read the two together; any difference between them is exactly what this submission
changes. If the `Review` line shows more than you intended to change, you have an
unintended edit — use `Load installed` and start again.

---

## 5. Local validation (before any wallet prompt)

The console validates the draft locally and lists every problem **before** Freighter
is ever prompted. The submit button stays disabled while any issue remains.

Validation rules you will hit:

- Caps must be whole numbers of units, or blank. `1,000` is rejected — separators
  are not accepted.
- Addresses must be valid Stellar addresses.
- **A rolling-window cap requires a non-zero window length**, or the cap can never
  apply.
- **`Active until` must be later than `Active from`.**
- **If assets are listed, the recipient allowlist is on, and no recipients are
  listed, every transfer is refused.** The form will say so. Add at least one
  recipient, or tick _Allow any recipient_.
- Protocol entries must be valid contract addresses.

Do not work around a validation error by leaving a field blank: blank means
"disabled", which is usually the opposite of what you intended.

---

## 6. Pre-flight security checklist

Tick every box that applies before signing.

- [ ] **Asset contract IDs verified on Stellar Expert.** For each address in
      **Assets**, open
      `https://stellar.expert/explorer/testnet/contract/<C…>` and confirm it is the
      token you think it is (symbol, issuer, decimals). A mistyped contract address
      that is still a valid `C…` string is the easiest way to install a policy that
      enforces caps on the wrong asset — or on nothing.
- [ ] **Recipient addresses verified.** Every allowlisted recipient is controlled by
      someone you intend to pay. An allowlist is a standing authorization: a wrong
      address is a permanent door.
- [ ] **Protocol allowlist is least-privilege.** Prefer `C…:fnA,fnB` over a bare
      `C…`. Recall the [enforcement scope](../enforcement-scope.md): for arbitrary
      protocol calls the engine enforces window, pause and allowlist state, but
      **not** per-call amount or recipient limits. The allowlist is the control that
      matters there.
- [ ] **Caps reflect the maximum you are willing to lose** in a single transaction
      and across one full window, not the agent's typical spend.
- [ ] **The window reset is accounted for** (section 1). After `set_policy`, the
      agent gets the full window allowance again.
- [ ] **The DMS clock reset is accounted for** (section 1).
- [ ] **`Active from` / `Active until` are in Unix seconds**, and are the interval
      you intend. A stale window set in the past can refuse everything.
- [ ] **Pause is deliberate.** If you are not ready for the agent to spend under the
      new rules, install **paused** and resume explicitly.
- [ ] **The `Review` line matches the change ticket.** If it does not, stop.
- [ ] **Rollback baseline captured** (section 3).

---

## 7. Submit

1. Confirm the `Review` line one more time.
2. Click **Sign and install policy**. Freighter prompts for signature.
3. The panel reports one of three outcomes — read which one:
   - **Landed on chain** — a `set_policy` transaction hash and ledger are shown. The
     receipt proves the write; it does not prove the policy is what you meant.
   - **Refused during simulation** — nothing was broadcast and nothing was paid.
     The detail names the stage. Fix and re-submit.
   - **Broadcast but rejected on chain** — a hash is shown and the transaction was
     included and rejected. The fee was spent. The detail explains why.
4. Any refused-decision diagnostics are pushed into the telemetry feed as
   **diagnostic** rows, labelled as such — they are local evidence of a refusal, not
   ledger history.
5. The panel re-reads the policy from the chain. Other tabs you have open receive a
   policy-updated broadcast and re-read automatically; they will **not** overwrite a
   draft you have in progress.

**Always verify after submitting — section 8.**

---

## 8. Verify the change post-submission

A submitted transaction is not an installed policy. Confirm on chain:

**In the console:** the Overview screen's **`Policy in force`** card must now show
the new policy. Compare it to your change ticket.

**From the chain:**

```bash
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- policy
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- status
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- window
```

Check specifically:

- [ ] Every field matches the draft you submitted — caps, assets, recipients,
      protocols, active window, pause state, DMS grace.
- [ ] **`window` shows the reset** (no or minimal prior spend), as expected.
- [ ] **`status.last_heartbeat` moved to now**, confirming the DMS clock restarted.
- [ ] The `set_policy` hash appears in the console's transaction history with a
      confirmed status and its fee.

Then prove the policy **behaves** as intended: the strongest evidence is an
end-to-end check like the one the Phase 3 proof records in
[`tests/fixtures/phase3-proof.json`](../../tests/fixtures/phase3-proof.json) — an
allowed transfer, a blocked transfer with the expected reason, and the resulting
state. Do it on testnet with a small amount before trusting the policy with real
value.

---

## 9. Rollback and recovery

If the new policy restricts more than intended, recover in this order — least
disruptive first.

### 9a. Resume if you installed paused

If the policy is correct but paused, resume it rather than reinstalling. A resume
does not reset the window or the DMS clock beyond what the install already did.

### 9b. Re-install the captured baseline

Restore the last-known-good policy:

1. Open `/configure`.
2. Use `Load installed` to see what is live, then re-enter the baseline values from
   section 3, **or** use `Clear form` followed by entering them.
3. Re-run sections 5–8.

Note the same two consequences apply on rollback: the rolling window resets and the
DMS clock restarts.

### 9c. Hard stop: revoke the policy

If you cannot reconstruct a safe policy right now and the agent must be stopped
**immediately**, `revoke_policy` puts the account back to **default deny**.

In the console: **Revoke policy (default deny)**. Or from the CLI:

```bash
stellar contract invoke --id "$GUARD" --source "$ADMIN_IDENTITY" --network testnet -- revoke_policy
```

Revoke does **not** reset the freeze state and does **not** unfreeze anything. The
agent will be refused every call until a new policy is installed — that is the
intended stop-the-world behaviour.

### 9d. If the account is frozen

`set_policy` and `revoke_policy` are admin-authorized calls, so they are themselves
**refused while `admin_frozen = true`**. If you need to change a policy on a frozen
account, follow the unfreeze checklist in the
[emergency freeze runbook](./emergency-freeze.md) first — and only after the
incident is understood.

### 9e. If the change was malicious or the admin key is compromised

Stop. Use the [emergency freeze runbook](./emergency-freeze.md), including key
rotation and, where the admin key itself is compromised, retiring the account and
deploying a fresh one from the pinned bytecode.

---

## 10. Recording the change

For every policy update, record:

- Guard address, timestamp, and operator.
- The `set_policy` (or `revoke_policy`) transaction hash.
- The **before** and **after** policy summaries (section 3 and section 8).
- The reason for the change and the risk it addresses.
- Whether the verification in section 8 passed.

The console's transaction history panel keeps a local record of this console's own
writes, exportable as CSV or JSON — but it is **local to the browser profile**. Export
it to durable storage whenever the change must remain auditable.

---

## 11. Escalation

- **Form validation, encoding, or UI problems:** open a GitHub issue on this
  repository with the draft that failed and the exact message.
- **Contract-level semantics** (`set_policy`, `revoke_policy`, window/DMS
  behaviour): `stellar-agent-guard-contracts`.
- **Agent runtime / SDK encoding:** `stellar-agent-guard-sdk`.

> ⚠️ This is unaudited security tooling that gates real fund access. Do not deploy
> to mainnet without an independent audit.
