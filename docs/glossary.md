# Glossary

Precise definitions of the Stellar, Soroban and Stellar Agent Guard terms used across this
project — in the README, the SPEC, the screen docs, and the console's own labels and tooltips.
Definitions are written to be unambiguous for developers, operators and contributors: when a word
appears in the interface or in an incident channel, it should mean exactly what it means here.

Entries marked **official docs** link to Stellar's own documentation; entries link to related
entries of this glossary and to this repository's docs where they go deeper. Nothing here
overrides the normative sources: the contracts repository's
[SPEC.md](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md)
owns the on-chain design, and this dashboard's [SPEC.md](../SPEC.md) owns the console's.

## Alphabetical index

- [Account Abstraction](#account-abstraction)
- [Admin Freeze](#admin-freeze)
- [Allowlist](#allowlist)
- [Contract Address](#contract-address)
- [Dead-Man's Switch (DMS)](#dead-mans-switch-dms)
- [Default-Deny](#default-deny)
- [Diagnostic Event](#diagnostic-event)
- [Event Cursor](#event-cursor)
- [Footprint](#footprint)
- [Freighter](#freighter)
- [Heartbeat](#heartbeat)
- [Ledger](#ledger)
- [Network Passphrase](#network-passphrase)
- [Observer Mode](#observer-mode)
- [Panic Button](#panic-button)
- [Pinned Bytecode](#pinned-bytecode)
- [Pre-flight Simulation](#pre-flight-simulation)
- [Read-only Simulation](#read-only-simulation)
- [Rolling Window](#rolling-window)
- [SAC (Stellar Asset Contract)](#sac-stellar-asset-contract)
- [ScVal](#scval)
- [Soroban](#soroban)
- [Soroban Auth Context](#soroban-auth-context)
- [Soroban RPC](#soroban-rpc)
- [Spending Policy](#spending-policy)
- [Stroop](#stroop)
- [WASM (WebAssembly)](#wasm-webassembly)
- [XDR (External Data Representation)](#xdr-external-data-representation)

## Entries

### Account Abstraction

Stellar's mechanism — also called **custom accounts** — by which an account's authorization rules
are defined by its own deployed contract code instead of fixed signature checks: the host hands the
authorization decision to the account's `__check_auth` entrypoint for every transaction the account
signs. A Stellar Agent Guard instance _is_ a custom account: `__check_auth` runs the installed
[Spending Policy](#spending-policy) and refuses any call it does not permit, which is why enforcement
happens inside the account rather than in a wrapper contract or an off-chain service.
**official docs:** [Authorization](https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization),
[Using `__check_auth` in interesting ways](https://developers.stellar.org/docs/build/guides/auth/check-auth-tutorials).
See also [Soroban Auth Context](#soroban-auth-context), [Spending Policy](#spending-policy).

### Admin Freeze

The operator-initiated freeze: the admin wallet signs `freeze()`, the contract sets
`admin_frozen = true`, and only an admin `unfreeze()` reverses it. It is one half of the
[double-freeze semantics](./concepts/dual-freeze-semantics.md) — deliberately distinct from a
[Dead-Man's Switch (DMS)](#dead-mans-switch-dms) freeze so an operator never mistakes a missed
heartbeat for an administrative lockout (or the reverse). Triggered from the
[Panic Button](#panic-button); confirmed only by re-reading `status()` after the write.
See also [Heartbeat](#heartbeat).

### Allowlist

A [Spending Policy](#spending-policy) component naming what is permitted instead of capping it:
recipient allowlists, asset allowlists and protocol allowlists. Allowlist enforcement is fullest
for [SAC (Stellar Asset Contract)](#sac-stellar-asset-contract) `transfer`/`transfer_from` calls,
because those are the calls whose arguments the [Soroban Auth Context](#soroban-auth-context)
exposes for inspection — the boundary is stated verbatim in the console's
[enforcement scope](./enforcement-scope.md) doc. See also [Default-Deny](#default-deny).

### Contract Address

The `C…` address identifying a deployed Soroban contract, derived deterministically from the
deployer address and a salt — so the address can be predicted _before_ signing, which the deploy
flow shows to the operator as part of its verification ritual. The console validates any guard
address it adopts (from a URL, a form or the fleet registry) against this exact form —
`C` followed by 55 base32 characters — and rejects anything else. See also
[Pinned Bytecode](#pinned-bytecode), [WASM (WebAssembly)](#wasm-webassembly).

### Dead-Man's Switch (DMS)

The automatic liveness freeze: if the agent misses its heartbeat grace window, the contract derives
the freeze on-chain from `last_heartbeat` versus the current ledger time and blocks the account
without anyone pressing anything. Installing or revoking a policy (`set_policy`/`revoke_policy`)
restarts the DMS clock. A DMS freeze clears by an agent [Heartbeat](#heartbeat) arriving within the
window or by an admin `unfreeze()` — never by waiting silently. Configured as "Dead-man grace
(seconds)" at deploy time; one half of the
[double-freeze semantics](./concepts/dual-freeze-semantics.md).
See also [Admin Freeze](#admin-freeze), [Heartbeat](#heartbeat).

### Default-Deny

The state of a guard with no [Spending Policy](#spending-policy) installed: every transaction the
account must authorize is blocked until a policy exists. The console raises a warning-tier banner
for this state because it is _safe but not what an operator assumes_ — "no policy" is a refusal
posture, not an error and not an empty form. An unreadable `status()` is never reported as
default-deny; it is reported as a failed read (see [no mock state](./concepts/no-mock-state.md)).
See also [Spending Policy](#spending-policy), [Account Abstraction](#account-abstraction).

### Diagnostic Event

A refusal reconstructed client-side from the diagnostics of a read-only
[Pre-flight Simulation](#pre-flight-simulation) of the call the guard rejected. A refused call
returns `Err` and is rolled back by Soroban's atomic semantics, so **no** committed on-chain event
exists for it — a feed tailing only committed events would show a contract that approves
everything. Diagnostic events are labelled `diagnostic` in the feed and always attributed to the
console's own refused writes; they are transient (local to the session) and never presented as
ledger history. Decision record:
[ADR 002 — Diagnostic Simulation for Rejections](./adr/002-diagnostic-simulation-for-rejections.md).
See also [Event Cursor](#event-cursor), [Read-only Simulation](#read-only-simulation).

### Event Cursor

The opaque bookmark Soroban RPC returns from `getEvents`, carried forward on every poll instead of
being re-derived from a ledger number — re-scanning from a ledger can skip events that fell outside
the window between polls. The cursor is what makes the telemetry feed's "live tail" continuous, and
its honest latency floor is the [Ledger](#ledger) close interval (~5 s), not the poll interval.
**official docs:** [`getEvents`](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents).
See also [Diagnostic Event](#diagnostic-event), [Soroban RPC](#soroban-rpc).

### Footprint

The set of ledger keys a Soroban transaction declares it will read and read-write, determined by
simulation and attached to the transaction before it is signed; it is what the network validates
against and a primary input to the resource fee. The console's enforced
[Pre-flight Simulation](#pre-flight-simulation) is therefore also what fixes the footprint a
submitted write will carry. **official docs:**
[Transaction Simulation](https://developers.stellar.org/docs/learn/fundamentals/contract-development/contract-interactions/transaction-simulation),
[Fees, Resource Limits, and Metering](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering).
See also [Stroop](#stroop), [Soroban RPC](#soroban-rpc).

### Freighter

The non-custodial browser-extension wallet the console signs with; it injects a provider into the
page, and every write in this dashboard is constructed in the operator's browser and approved
there. The console reads Freighter's network on connect and refuses a session whose
[Network Passphrase](#network-passphrase) differs from this deployment's — a signature for a
different network id cannot authorize a call here. See the console's own architecture note:
[Client-Side Freighter Architecture](./concepts/client-side-freighter-architecture.md).
**official docs:** [Freighter Wallet](https://developers.stellar.org/docs/build/guides/freighter),
[Freighter developer docs](https://docs.freighter.app/). See also [Observer Mode](#observer-mode).

### Heartbeat

The agent's periodic `heartbeat()` call updating `last_heartbeat` and proving the agent is alive.
It requires the _guard's own_ authentication (the agent key), which is why the console deliberately
never sends one — the admin key has no liveness-forging power. A missed heartbeat inside the grace
window is what triggers the [Dead-Man's Switch (DMS)](#dead-mans-switch-dms).
See also [Account Abstraction](#account-abstraction), the
[agent integration guide](./guides/agent-integration.md).

### Ledger

Stellar's blocks: the network closes a ledger roughly every five seconds, each with a sequence
number and a close time. The ledger is the time source for everything time-based in this system —
event `ledger_closed_at` timestamps, the [Dead-Man's Switch (DMS)](#dead-mans-switch-dms) clock,
and the honest latency floor of the telemetry feed — and ledger entries are where policy, window
and freeze state physically live (`getLedgerEntries`). **official docs:**
[Blockchain Glossary](https://developers.stellar.org/docs/learn/glossary).
See also [Event Cursor](#event-cursor), [Soroban RPC](#soroban-rpc).

### Network Passphrase

The human-readable string that identifies a Stellar network and domains every signature to it —
`Test SDF Network ; September 2015` for testnet, `Public Global Stellar Network ; September 2015`
for mainnet. This build pins one passphrase and one RPC endpoint (`NETWORK` in
`lib/guard/network.ts`), the header states it, and the wallet must match it before a session opens.
**official docs:** [Mainnet, Testnet & Futurenet](https://developers.stellar.org/docs/networks).
See also [Freighter](#freighter), [Soroban RPC](#soroban-rpc).

### Observer Mode

A session with no connected wallet: reads still run — attributed to a known fallback source
account, since a read-only simulation needs a source but mutates nothing and is never charged —
while every write control is disabled with a stated reason rather than left silently inert.
Observer mode is why the console can show a broken write control that explains itself instead of a
button that pretends. See also [Read-only Simulation](#read-only-simulation),
[Freighter](#freighter).

### Panic Button

The two-step emergency freeze in the console: explicit confirmation, then a wallet-signed
`freeze()`, then a **mandatory** re-read of `status()` that must report `admin_frozen = true`
before the UI claims success — a submitted transaction is not a frozen account. Reversal is the
matching wallet-signed `unfreeze()`. Operator procedure:
[Emergency Freeze runbook](./runbooks/emergency-freeze.md), screen doc:
[Panic Button & Freeze](./screens/panic-freeze.md). See also [Admin Freeze](#admin-freeze),
[Pre-flight Simulation](#pre-flight-simulation).

### Pinned Bytecode

The Phase 1 artifact's identity as fixed constants — SHA-256
`f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` and byte length `39673` —
against which every deploy is verified: the dashboard fetches the WASM bytes off the ledger, hashes
them in the browser, and refuses to prompt a signature on any mismatch, then re-reads the deployed
instance and re-verifies it before adopting it. "Deployed" therefore means "runs the pinned
artifact", not "a transaction was signed". Details:
[Bytecode Verification & Pinning](./concepts/bytecode-verification-pinning.md).
See also [WASM (WebAssembly)](#wasm-webassembly), [Contract Address](#contract-address).

### Pre-flight Simulation

Simulating a transaction before it is ever broadcast — and, in this project's strict sense, the
enforced simulation that runs the **real** `__check_auth` so the guard's verdict is obtained before
any signature or submission: recording mode first to learn the authorization entries the host
requires, then enforcement. If it is refused, nothing is signed and nothing is sent, and the
refusal is surfaced as a [Diagnostic Event](#diagnostic-event). This is also where the
[Footprint](#footprint) and resource fees of the write are fixed.
**official docs:**
[Transaction Simulation](https://developers.stellar.org/docs/learn/fundamentals/contract-development/contract-interactions/transaction-simulation),
[`simulateTransaction`](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/simulateTransaction).
See also [Read-only Simulation](#read-only-simulation), [Account Abstraction](#account-abstraction).

### Read-only Simulation

`simulateTransaction` used purely to _read_ contract state (`status()`, `policy()`, balance) with a
fallback source account: it mutates nothing, costs nothing, and its failure is rendered as an
explicit error — never as a zero or a stale value (see [no mock state](./concepts/no-mock-state.md)).
Distinct from the enforcing [Pre-flight Simulation](#pre-flight-simulation), which executes the
real authorization decision for a write the operator is about to make. **official docs:**
[`simulateTransaction`](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/simulateTransaction).
See also [Observer Mode](#observer-mode), [Soroban RPC](#soroban-rpc).

### Rolling Window

The spend-limit mechanism that caps how much the guarded account may move across a **trailing**
time window — a cap paired with a window length, enforced by the policy engine as a continuously
sliding accounting rather than a per-epoch budget. The window's current consumption is account
storage (`DataKey::Window`), read straight from the ledger via `getLedgerEntries` because no read
function exposes it, and installing a new policy resets it. Amounts are denominated in
[Stroop](#stroop). Configure it in the [policy configurator](./screens/policy-configurator.md).
See also [Spending Policy](#spending-policy), [Ledger](#ledger).

### SAC (Stellar Asset Contract)

The network's built-in contract interface for classic Stellar assets — including XLM — which makes
a trustline asset callable from Soroban with `transfer`/`transfer_from` and the rest of the token
API. SAC transfers are the calls where the guard's fine-grained enforcement is complete, because
their arguments (recipient, amount, asset) are exactly what the
[Soroban Auth Context](#soroban-auth-context) exposes for inspection — the boundary the console
states verbatim wherever a capability is described ([enforcement scope](./enforcement-scope.md)).
**official docs:** [Stellar Asset Contract (SAC)](https://developers.stellar.org/docs/tokens/stellar-asset-contract).
See also [Allowlist](#allowlist), [Stroop](#stroop).

### ScVal

Soroban Contract Value — the SDK's encoding of any value that crosses the contract boundary:
policy fields, addresses, symbols, amounts. The SDK's `policyToScVal` encodes the
[Spending Policy](#spending-policy) for `set_policy`, and the console decodes what it reads back
through the SDK's `decodePolicy`, so one vocabulary governs both directions. **official docs:**
[Data types (frontend guide)](https://developers.stellar.org/docs/build/guides/dapps/frontend-guide).
See also [XDR (External Data Representation)](#xdr-external-data-representation).

### Soroban

Stellar's smart-contract platform: contracts written in Rust, compiled to
[WASM (WebAssembly)](#wasm-webassembly), executed by the network's metered runtime with fees and
limits derived from actual resource usage. Every mechanism this project builds on — custom
accounts, the SAC, simulation, events — is a Soroban facility. **official docs:**
[Contract development](https://developers.stellar.org/docs/learn/fundamentals/contract-development).
See also [Account Abstraction](#account-abstraction), [Soroban RPC](#soroban-rpc).

### Soroban Auth Context

The authorization context the host hands a custom account's `__check_auth`: the tree of authorized
invocations for the transaction, each entry naming the contract, function and **arguments** of a
call the account is being asked to authorize. It is the mechanism that makes policy enforcement
possible at all — the console's per-recipient/per-amount rules inspect precisely these exposed
arguments, which is why transfers of SAC assets are fully enforceable while arbitrary protocol
calls are only covered by window and pause state (see [enforcement scope](./enforcement-scope.md)).
**official docs:**
[Authorization](https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization),
[Stellar Transaction (auth trees)](https://developers.stellar.org/docs/learn/fundamentals/contract-development/contract-interactions/stellar-transaction).
See also [Account Abstraction](#account-abstraction), [SAC (Stellar Asset Contract)](#sac-stellar-asset-contract),
[Allowlist](#allowlist).

### Soroban RPC

The state-access API the console talks to directly from the browser — `simulateTransaction`,
`getEvents`, `getLedgerEntries`, `getContractInstance` and the rest — with no server component in
between: Soroban RPC serves permissive CORS precisely so a client can. This build pins the public
testnet endpoint in `lib/guard/network.ts`; every number on screen comes from one of its
responses, and a failed response renders as a failed read, never as a default.
**official docs:** [Stellar RPC API reference](https://developers.stellar.org/docs/data/apis/rpc/api-reference).
See also [Event Cursor](#event-cursor), [Read-only Simulation](#read-only-simulation).

### Spending Policy

The complete rule set installed on a guard by the admin via `set_policy` — per-transaction cap,
[Rolling Window](#rolling-window) cap and length, [Allowlist](#allowlist)s, active execution
windows, pause state, and the [Dead-Man's Switch (DMS)](#dead-mans-switch-dms) grace period — in
exactly the shape `set_policy` takes, so a draft can be validated against the same rules the
contract applies. While none is installed the guard is [Default-Deny](#default-deny). Written only
by the admin key, encoded via the SDK (`policyToScVal`), and re-read from the chain after every
write. Screen doc: [Policy Configurator](./screens/policy-configurator.md).
See also [Account Abstraction](#account-abstraction), [ScVal](#scval).

### Stroop

The smallest unit of a Stellar asset: one ten-millionth (10⁻⁷) — as cents are to dollars, stroops
are to XLM. Every amount the contract stores and every cap in a policy is an integer count of
stroops; the console holds them as `BigInt` (no floating point near money), formats them for display
with a toggle to the exact raw value, and keeps 64-bit values as strings in exports so no precision
is lost. **official docs:**
[Assets on Stellar](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/assets),
[Blockchain Glossary](https://developers.stellar.org/docs/learn/glossary).
See also [Rolling Window](#rolling-window), [SAC (Stellar Asset Contract)](#sac-stellar-asset-contract).

### WASM (WebAssembly)

The bytecode format smart contracts deploy and run as. The guard artifact is a WASM module; the
ledger stores its bytes as a `ContractCode` entry addressed by their hash, which is what makes
[Pinned Bytecode](#pinned-bytecode) verifiable — the console fetches those exact bytes, hashes
them, and compares against the pinned constant before any deploy signature.
**official docs:** [Contract development](https://developers.stellar.org/docs/learn/fundamentals/contract-development).
See also [Soroban](#soroban), [Contract Address](#contract-address).

### XDR (External Data Representation)

Stellar's binary serialization: transactions and their envelopes are XDR, ledger entries are XDR,
and raw events carry their payloads as XDR. The console never invents a parallel format for these —
it exports the raw event XDR alongside decoded fields, and the unsigned-envelope workflow
(export → external signing → import) moves an XDR envelope rather than a bespoke structure, which
is what makes air-gapped and multisig signing possible. **official docs:**
[Transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions).
See also [ScVal](#scval), [Freighter](#freighter).
