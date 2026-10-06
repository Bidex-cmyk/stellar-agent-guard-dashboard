# 3. Non-Custodial Freighter Wallet Signing Model

Date: 2026-09-25

## Status

Accepted

## Context

Every privileged action this console offers — deploying the pinned artifact, initializing a guard,
installing or revoking a policy, freezing and unfreezing — is a write to a smart account that holds
an agent's funds. Whoever can produce a signature the account accepts can change what that account
is allowed to do, so the signing model is not an implementation detail: it is the product's security
boundary.

[ADR 001](./001-zero-server-architecture.md) already decided there is no server. That decision
removes the obvious place a secret key would live, but it does not by itself answer three questions
the write path must answer:

1. Where, physically, is a signature produced, and what exactly gets signed?
2. How can the application enforce the guard's decision _before_ the operator is asked to approve
   anything, given the browser never holds a key?
3. What stops a signature produced for one Stellar network from being replayed against another?

Freighter — the operator's browser-extension wallet — is the component that answers the first
question. The console's job is to integrate it in a way that never weakens the answer.

## Decision

The dashboard is strictly non-custodial: **secret keys are never handled by application JavaScript,
never transmitted, never stored, and never derivable from anything the application sees.** All
signing happens inside the operator's wallet, and the application's role is limited to building
unsigned payloads, passing them to the wallet, and forwarding the signatures it receives back.

### The two-step simulation-then-signature flow

Writes follow the sequence the Stellar host requires, with a deliberate division of labour between
the console and the wallet at each step. This is the same `WalletSigner` pipeline described in
`SPEC.md` §5; the flow below is annotated with which side holds the key at each moment:

```
console (no key)                          wallet (holds the key)
────────────────────────                  ──────────────────────────
build probe (unsigned envelope)
simulate — recording pass ──────►    (no signature yet; the host reports
                                      which authorizations the call needs)
for each required auth entry:
  entry XDR ──────────────────────►  operator reviews & signs the ENTRY
signed entry ◄─────────────────────  (signature over that entry's exact
                                      preimage, inside the extension)
simulate — enforced pass ───────►    (the REAL __check_auth runs against
                                      live ledger state; a policy refusal
                                      happens HERE, nothing is broadcast)
if refused → stop, no hash, no fee
assemble priced transaction
unsigned envelope ───────────────►   operator reviews & signs the ENVELOPE
signed envelope ◄─────────────────
submit to Soroban RPC, poll
```

Two properties of this sequence are load-bearing:

- **The enforced simulation runs before the operator is ever asked to sign the envelope.** The
  guard's `__check_auth` executes during that second simulation against live chain state, so a
  refused call — frozen account, cap exceeded, recipient not allowlisted — is returned to the user
  with the contract's own reason and **no transaction is broadcast, no fee is spent, and no
  authorization is ever requested** for a call the guard would reject. The wallet prompt is the
  operator's approval; showing it only for calls that have already passed enforcement is what makes
  the approval meaningful.
- **Each signature is over the exact payload the host will re-derive, nothing more.** Authorization
  entries are signed individually (Freighter can prompt twice per write: once per entry, then for
  the envelope), and the console never mutates an operation after its entries are signed — it
  rebuilds the operation with the signed entries attached and re-simulates, so the host's
  re-derivation matches what was approved.

### Why application JavaScript never touches a secret key

The seam is [`lib/guard/wallet.ts`](../../lib/guard/wallet.ts): every signing capability in the
console is expressed as the `WalletSigner` interface (`address`, `signTransaction`, `signAuthEntry`)
— it can _request_ signatures, and nothing else. The Freighter adapter implements that interface by
calling the extension; there is no code path in which a private key is an argument, a return value,
or a byte in application memory:

- There is no server (ADR 001), so there is no API route to submit a key to, and no database to
  persist one to. The console is a static bundle; an attacker who compromises it wholesale gets
  unsigned payloads, not keys.
- The extension holds the key material (in a hardware-backed wallet, the key never leaves the
  device at all) and displays what it is asked to sign to the operator. The console cannot see the
  key and cannot silently broaden what is being signed: it can only submit a payload for approval,
  and the operator approves (or rejects) the payload the extension displays.
- The only place keypair-backed signing exists in this repository is the headless Phase 3 proof
  (`scripts/prove-phase3.ts`), which substitutes a `WalletSigner` backed by a funded test keypair to
  drive the identical library code in Node. That path is a test harness, is never reachable from
  the browser bundle, and exists precisely because the seam makes the substitution possible.
- The console cannot act as the agent at all. The agent key lives in the agent runtime (the SDK);
  the admin key lives in the wallet; no operation in this UI mixes the two. `heartbeat` and other
  guard-authorized calls are absent from this console by design, not by omission.

### Network passphrase pinning against cross-network signature replay

A Stellar signature is made over a payload that includes the **network passphrase**. The same
signed envelope is therefore meaningless on a different network: Testnet's `Test SDF Network ;
September 2015` and Mainnet's `Public Global Stellar Network ; September 2015` produce different
signatures over identical operations. Cross-network replay — taking a Testnet approval and
broadcasting it to Mainnet — fails at the host for that reason _by protocol design_.

The console does not rely on that alone, because a signature the host will refuse is still a
signature the operator was tricked into approving. Two layers are enforced:

1. **At connection.** `connectWallet()` reads the network Freighter is currently pointed at via
   `getNetworkDetails()` and the dashboard refuses to connect if the wallet's passphrase does not
   match this deployment's `NETWORK.passphrase` (`lib/guard/network.ts`). The operator is told which
   network their wallet is on and which network the dashboard expects, and nothing is signed at all
   until they match. Failing at connection is cheaper than failing after an approval the operator
   did not understand.
2. **At signing.** `freighterSigner(address, networkPassphrase)` is constructed with the pinned
   passphrase and passes it explicitly to both `signAuthEntry` and `signTransaction`. The wallet is
   therefore asked to sign _for this network_ rather than for whichever network it happens to be
   showing at that moment — a wallet switched mid-session cannot produce a signature for the wrong
   network through this console.

### Signature isolation between console and wallet

The console and the wallet trust each other for nothing beyond the interface:

- The console decides _what_ to build (operation, arguments, footprint) but cannot decide _whether_
  a signature happens — the operator does, per prompt, in the extension.
- The wallet decides _whether_ to sign but cannot decide _what_ was signed — it signs the payload it
  was handed, which the operator can inspect on the extension's prompt (and, with a hardware wallet,
  on the device screen — see the threat model below).
- Refusals at either layer are terminal and visible: a declined entry or envelope aborts the write
  with an explicit message, and nothing partially-signed is ever submitted.

## Security guarantees and their limits

What this model guarantees:

- **No key custody anywhere in the application surface** — no repo, no build artifact, no server,
  no localStorage entry contains or can reconstruct a secret key.
- **No signature without an operator's explicit approval**, per authorization entry and per
  envelope, displayed by the wallet.
- **No approval requested for a call the guard will refuse** — enforcement precedes the signing
  prompt by construction.
- **No cross-network replay** — protocol-level network-id binding, plus the console's own
  connection-time and signing-time passphrase checks.
- **No silent substitution of payloads** — signed entries are carried unchanged into the enforcing
  simulation and the submitted transaction.

What it does **not** guarantee (stated plainly, per the repo's no-overclaim convention):

- It cannot stop an operator from approving a _correctly-displayed but harmful_ operation. The
  guard's policy is the control for that; the wallet prompt is confirmation, not a policy engine.
- It cannot detect a compromised wallet extension that signs payloads without displaying them. The
  mitigations are the operator's choice of wallet (see threat model) and the guard contract itself,
  which independently rejects unauthorized changes even with a signature in hand.
- It cannot protect a machine whose browser or OS is already hostile; a hostile client can spoof
  what the operator sees. High-value operations should assume this and use hardware signing.

## Threat model: hardware vs software wallets

The signing model is identical for both; what differs is where the operator's confirmation happens
and what an attacker must defeat to forge it.

|                       | **Software wallet** (Freighter holding a key in the extension)                                                                        | **Hardware wallet** (Freighter backed by a Ledger-class device)                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Key storage           | Encrypted in the browser extension's storage                                                                                          | Secure element / sealed in the device; never extractable                                                                                      |
| Operator confirmation | The extension's UI in the same browser as the app                                                                                     | The **device's own screen and buttons**, independent of the browser                                                                           |
| Defeat requires       | Compromising the extension or the browser profile                                                                                     | Physical possession of the device **and** its PIN                                                                                             |
| Residual risk         | A malicious or compromised extension can display one payload and sign another; browser-level malware can overlay or misrender prompts | Blind-signing if the device's firmware cannot decode the payload — mitigated by verifying the transaction hash in chunks on the device screen |
| Suited for            | Day-to-day policy edits, testnet work, low-value guards                                                                               | High-value admin writes: deploys, `set_policy` on production guards, `freeze`/`unfreeze`                                                      |

Two console behaviours exist specifically to support hardware verification:

- The deploy flow predicts the contract address from `(deployer, salt)` and shows it **before** any
  signature is requested, so the address on the device screen can be compared with what the console
  claims.
- During signing, the hardware guide (`lib/guard/hardwareGuide.ts`,
  `components/HardwareWalletGuide.tsx`) surfaces the contract ID, the method, and the transaction
  hash — uppercased and chunked into 8-character blocks by `formatHashForDevice`, matching how
  Ledger paged displays present hashes — so the hash on the device can be compared against the hash
  the console assembled, character group by character group.

Software wallets remain acceptable for Testnet and for guards whose caps bound the worst case to an
acceptable loss. For a guard moving real value, the hardware row of the table above is the
recommendation, and the freeze path is designed to be completable from a hardware-held admin key —
incidents are precisely when one wants the stronger confirmation channel.

## Consequences

### Positive

- **Custody is structurally impossible, not procedentially discouraged.** There is no component in
  this repository that _could_ hold a key, so "we promise not to look at the keys" is never part of
  the trust model.
- **Approvals are informed.** Every wallet prompt corresponds to a payload that has already passed
  the guard's enforced simulation, and the extension displays the exact bytes being signed.
- **Replay across networks is refused twice** — once by the console at connection/signing time, and
  once by the host's network-id binding if anything slips past.
- **The seam is testable.** Because `WalletSigner` is the only signing surface, the identical write
  path is proven on-chain headlessly with a keypair-backed signer, and the browser-only code
  shrinks to the thin Freighter adapter.

### Negative

- **Every write requires the wallet's presence.** A missing extension, a locked extension, or a
  mismatched network blocks all admin actions; the CLI fallback in the runbooks exists for this.
- **Two prompts per write** (authorization entry, then envelope) is more friction than a
  custodial "click to confirm" would be. The friction is the feature: each prompt is a distinct
  approval of a distinct payload.
- **Simulation adds latency** between intent and prompt. The enforced simulation is what makes the
  prompt trustworthy, so it is not optional.

### Neutral

- The Freighter adapter is the single browser-extension touchpoint in `lib/`; swapping or adding a
  wallet means implementing `WalletSigner`, not reworking the write path.
- Hardware-wallet verification depends on device firmware rendering Soroban payloads; the
  hash-comparison guide is the fallback that does not depend on richer payload decoding.

## References

- [ADR 001 — Zero-Server Client-Only Architecture](./001-zero-server-architecture.md)
- [ADR 002 — Diagnostic Simulation for Rejected Transaction Visibility](./002-diagnostic-simulation-for-rejections.md)
- [SPEC.md §5 — Write path](../../SPEC.md)
- [Client-side Freighter architecture](../concepts/client-side-freighter-architecture.md)
- [Operator runbook — Emergency Freeze](../runbooks/emergency-freeze.md)
- [Operator runbook — Agent key rotation](../runbooks/agent-key-rotation.md)
