# Agent Integration Guide: Connecting Custom AI Agent Runtimes to Guard Dashboard

This guide provides end-to-end instructions for connecting custom AI agent runtimes to a deployed `stellar-agent-guard` smart account and monitoring the agent's live operations through the operator dashboard console.

---

## Overview & Architecture

Stellar Agent Guard provides an on-chain spending firewall for autonomous AI agents. Rather than holding funds in a standard private-key wallet or relying on centralized off-chain intermediaries, an autonomous agent operates as a Soroban **Custom Account**.

Every action requiring the account's authorization is routed by the Stellar network through the contract's `__check_auth` entrypoint. The contract enforces granular policy guardrails on-chain:
* Per-transaction spend caps
* Rolling-window spend limits and duration
* Asset and SAC token allowlists
* Recipient address allowlists
* Non-asset protocol and function allowlists
* Active execution time windows and pause flags
* Dead-man switch heartbeat grace periods
* Instant operator admin freeze

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Operator Dashboard                              │
│              (Deploy Guard, Set Policy, Panic Freeze, Telemetry)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    │ (On-chain state & getEvents polling)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Soroban Testnet RPC                           │
│     ┌────────────────────────────────────────────────────────────┐     │
│     │               Guard Smart Account (Custom Account)          │     │
│     │   - `__check_auth`: On-chain policy decision engine        │     │
│     │   - `heartbeat`: Dead-man switch keep-alive reset          │     │
│     └─────────────────────────────▲──────────────────────────────┘     │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │ Pre-flight simulation & Invocation
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│                    AI Agent Runtime Environment                        │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ Agent Framework (LangChain, ElizaOS, or Custom Autonomous Loop)│   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │ Tool Calls / Actions               │
│                                   ▼                                    │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │               stellar-agent-guard-sdk (Node.js)                │   │
│   │   • PreFlightInterceptor: Zero-fee simulation check            │   │
│   │   • CostPreChecker: In-process resource fee estimation        │   │
│   │   • invoke(): Agent-auth signing & atomic broadcast           │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Deploying a Guard Through the Dashboard

Before an agent can operate under a guard, an operator must deploy and initialize a Guard custom account instance.

### Step 1: Connect the Admin Wallet
1. Open the dashboard console in a browser with the [Freighter](https://www.freighter.app/) extension installed.
2. Ensure Freighter is switched to **Testnet**.
3. In the top [`WalletBar`](../../components/WalletBar.tsx), click **Connect admin wallet** and approve connection.

### Step 2: Navigate to the Configurator
Click the **Configure** tab in the navigation header (URL: `/configure`).

### Step 3: Verify the Pinned Artifact
The [`DeployPanel`](../../components/DeployPanel.tsx) automatically reads the bytecode from Stellar Testnet and verifies its SHA-256 hash against the pinned Phase 1 artifact:
* **Pinned WASM Hash**: `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63`
* **WASM Size**: `39673 bytes`
* **Identity Status**: Must display `matches` (`var(--ok)`). If an artifact mismatch occurs, the dashboard strictly refuses to deploy.

### Step 4: Review Predicted Guard Address & Deploy
1. The dashboard derives a cryptographic salt and computes the predicted contract address (`C...`) before any transaction is signed.
2. Click **Deploy guard**.
3. Freighter will prompt to sign:
   * `upload_contract_wasm` (if the pinned bytecode is not already live on the ledger).
   * `create_custom_contract` using the admin address and computed salt.
4. Once submitted, the dashboard re-reads the contract from the ledger and verifies the deployed instance byte-for-byte.

### Step 5: Obtain & Copy the Contract Address
Upon confirmation, the success banner displays:
```
Deployed and verified against the pinned artifact
CC6VDBH5M473O4XUPD5GNRVIPB6CJ4U6IZCITF7XLKNLMWZPP3U5BMTK
```
Copy this **56-character contract address** (starting with `C`). This is your `GUARD_CONTRACT_ADDRESS`.

### Step 6: Initialize the Guard with the Agent Key
Below the deploy card, locate the **Initialize a guard** section:
1. Generate or retrieve your agent's Ed25519 keypair.
2. The contract requires the agent's **32 raw Ed25519 public key bytes in hex** (not the `G...` strkey format).
   * *In TypeScript*:
     ```ts
     import { Keypair, StrKey } from "@stellar/stellar-sdk";
     const agentKeypair = Keypair.fromSecret("S...");
     const rawPubkey = StrKey.decodeEd25519PublicKey(agentKeypair.publicKey());
     const agentPubkeyHex = Buffer.from(rawPubkey).toString("hex");
     console.log(agentPubkeyHex);
     ```
3. Paste the 64-character hex string into **Agent public key (32 raw Ed25519 bytes, hex)**.
4. Click **Sign and initialize**. Freighter will sign the `initialize(admin, agent_pubkey)` transaction.

### Step 7: Configure Initial Policy Rules
In the **Policy Form** on the same `/configure` page:
1. Define your initial policy constraints:
   * **Per-transaction cap**: Maximum amount allowed in a single transaction (in stroops or human XLM).
   * **Rolling-window cap & duration**: Spend ceiling over a rolling duration (e.g., 200 XLM over 3600 seconds).
   * **Allowed Assets**: Contract addresses for allowlisted SAC tokens.
   * **Allowed Recipients**: Public keys (`G...`) for approved transfer destinations.
   * **Dead-man grace period**: Time in seconds (e.g., `3600`) before an inactive agent auto-freezes.
2. Click **Save policy configuration** and sign in Freighter.

### Step 8: Verify Readiness
Return to the **Console** tab (`/`):
* Confirm `StatusPanel` shows:
  * **Admin freeze**: `clear` (tone `ok`)
  * **Dead-man switch**: `within grace` (tone `ok`)
  * **Policy installed**: `yes`

The Guard is now live and waiting for agent transactions.

---

## Phase 2: Agent Runtime Configuration

The AI agent runtime communicates with Soroban RPC and the Guard using environment variables.

### Environment Variable Specification

| Variable Name | Required | Type | Description |
| :--- | :--- | :--- | :--- |
| `STELLAR_RPC_URL` | **Yes** | URL (Public) | Soroban RPC endpoint (e.g., `https://soroban-testnet.stellar.org`). |
| `STELLAR_NETWORK_PASSPHRASE` | **Yes** | String (Public) | Passphrase identifying the network (`Test SDF Network ; September 2015`). |
| `GUARD_CONTRACT_ADDRESS` | **Yes** | String (Public) | 56-character Soroban contract address (`C...`) obtained from dashboard deployment. |
| `AGENT_SECRET` | **Yes** | Secret (`S...`) | Secret seed of the agent key registered during `initialize`. Used for auth entry signatures. |
| `SOURCE_SECRET` | **Yes** | Secret (`S...`) | Secret seed of a funded classic Stellar account used to pay transaction gas fees and supply sequence numbers. Can be the same as agent key if funded. |
| `MAX_FEE_STROOPS` | No | Integer | Maximum acceptable resource fee in stroops (default: uncapped pre-check). |

### Example `.env` File

Create a `.env` file in the root of your agent runtime project:

```env
# Network Configuration
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Deployed Guard Custom Account
GUARD_CONTRACT_ADDRESS=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

# Agent Keypair (signs __check_auth SorobanAuthorizationEntry)
AGENT_SECRET=SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Fee-Payer Account (pays transaction base fee and envelope sequence)
SOURCE_SECRET=SAYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY

# Optional Cost Limit
MAX_FEE_STROOPS=1000000
```

> [!CAUTION]
> Never commit `AGENT_SECRET` or `SOURCE_SECRET` to source control. Ensure `.env` is listed in your `.gitignore`.

---

## Phase 3: TypeScript Integration Example

The official first-party SDK is [`stellar-agent-guard-sdk`](https://github.com/aigbagbobila/stellar-agent-guard-sdk).

### Installation

```bash
npm install stellar-agent-guard-sdk @stellar/stellar-sdk
```
*(Requires Node.js `>= 24.0.0`)*

### Implementation (`agent.ts`)

```ts
import { Keypair, Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  invoke,
  GuardBlockedError,
  explainReason,
  type ContractCall,
} from "stellar-agent-guard-sdk";

// 1. Load configuration from environment
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const guardAddress = process.env.GUARD_CONTRACT_ADDRESS!;
const agentKeypair = Keypair.fromSecret(process.env.AGENT_SECRET!);
const sourceKeypair = Keypair.fromSecret(process.env.SOURCE_SECRET!);

const server = new rpc.Server(rpcUrl);

// 2. Initialize the PreFlightInterceptor
const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase,
  guard: guardAddress,
  agent: agentKeypair,
  source: sourceKeypair,
});

/**
 * 3. Send Agent Heartbeat
 * Resets the on-chain dead-man-switch clock.
 */
export async function sendHeartbeat(): Promise<void> {
  console.log("Broadcasting agent heartbeat to Guard...");
  
  const outcome = await invoke({
    server,
    source: sourceKeypair,
    networkPassphrase,
    call: {
      contract: guardAddress,
      fn: "heartbeat",
      args: [],
    },
    guardAuth: {
      guard: guardAddress,
      agent: agentKeypair,
    },
  });

  if (outcome.kind === "allowed") {
    console.log(`✓ Heartbeat confirmed on ledger ${outcome.submission.ledger} (tx: ${outcome.submission.hash})`);
  } else if (outcome.kind === "blocked") {
    console.error(`✗ Heartbeat blocked by Guard: ${outcome.reason} (${outcome.detail})`);
  } else {
    console.error(`✗ Heartbeat failed: ${outcome.detail}`);
  }
}

/**
 * 4. Execute a Guarded SAC Token Transfer
 * Runs pre-flight simulation before signing for broadcast.
 */
export async function transferTokens(
  tokenContractId: string,
  recipientAddress: string,
  amountStroops: bigint
): Promise<string> {
  const call: ContractCall = {
    contract: tokenContractId,
    fn: "transfer",
    args: [
      new Address(guardAddress).toScVal(),
      new Address(recipientAddress).toScVal(),
      nativeToScVal(amountStroops, { type: "i128" }),
    ],
  };

  // Step A: Pre-Flight Interception (Free, no broadcast)
  const decision = await interceptor.check(call);

  if (!decision.allowed) {
    if (decision.kind === "blocked") {
      console.warn(`[PRE-FLIGHT BLOCKED] Reason: ${decision.reason} - ${decision.explanation}`);
      throw new GuardBlockedError({
        reason: decision.reason,
        stage: "preflight",
        detail: decision.detail,
        charged: false,
      });
    } else {
      console.error(`[PRE-FLIGHT UNDETERMINED] Call could not be verified: ${decision.detail}`);
      throw new Error(`Enforcement undetermined: ${decision.detail}`);
    }
  }

  console.log(`✓ Pre-flight passed (estimated resource fee: ${decision.estimatedResourceFee} stroops)`);

  // Step B: Full Invocation Pipeline (atomic broadcast)
  const outcome = await invoke({
    server,
    source: sourceKeypair,
    networkPassphrase,
    call,
    guardAuth: {
      guard: guardAddress,
      agent: agentKeypair,
    },
  });

  if (outcome.kind === "allowed") {
    console.log(`✓ Transaction broadcast succeeded: ${outcome.submission.hash}`);
    return outcome.submission.hash;
  } else if (outcome.kind === "blocked") {
    throw new GuardBlockedError({
      reason: outcome.reason ?? "unknown",
      stage: "submission",
      detail: outcome.detail,
      charged: false,
    });
  } else {
    throw new Error(`Transaction failed: ${outcome.detail}`);
  }
}
```

---

## Phase 4: Python Integration Architecture

The official `stellar-agent-guard-sdk` is written in TypeScript for Node.js environments. For Python-based agent runtimes (e.g., Python LangChain, AutoGen, CrewAI), there are two verified integration approaches:

### Pattern A: Sidecar / Microservice Bridge (Recommended for Full Policy Pre-Flight)

Because Soroban's Custom Account Abstraction requires building custom `SorobanAuthorizationEntry` objects with `sorobanCredentialsAddressV2` preimages, the cleanest architecture uses a lightweight Node.js sidecar running `stellar-agent-guard-sdk` exposing local endpoints:

```
[ Python Agent Runtime ] 
       │
       │ HTTP / IPC (`POST /check`, `POST /invoke`, `POST /heartbeat`)
       ▼
[ Local Node.js Guard Sidecar ] (stellar-agent-guard-sdk)
       │
       │ Soroban RPC (simulateTransaction / sendTransaction)
       ▼
[ Soroban Testnet / Guard Contract ]
```

### Pattern B: Native Python Integration via `stellar-sdk`

Python agents can directly query the Guard contract and send heartbeats using the official [`stellar-sdk` Python package](https://github.com/StellarCN/py-stellar-base):

```bash
pip install stellar-sdk
```

#### Native Python Heartbeat Implementation (`agent_guard.py`):

```python
import os
import time
from stellar_sdk import Server, Keypair, Network, TransactionBuilder
from stellar_sdk.soroban_types import ScVal
from stellar_sdk.exceptions import BadRequestError

# 1. Configuration
RPC_URL = os.getenv("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org")
NETWORK_PASSPHRASE = os.getenv("STELLAR_NETWORK_PASSPHRASE", Network.TESTNET_NETWORK_PASSPHRASE)
GUARD_ADDRESS = os.getenv("GUARD_CONTRACT_ADDRESS")
AGENT_SECRET = os.getenv("AGENT_SECRET")
SOURCE_SECRET = os.getenv("SOURCE_SECRET")

server = Server(RPC_URL)
agent_keypair = Keypair.from_secret(AGENT_SECRET)
source_keypair = Keypair.from_secret(SOURCE_SECRET)

def read_guard_status():
    """Read the guard status view function to inspect heartbeat and freeze flags."""
    source_account = server.load_account(source_keypair.public_key)
    tx = (
        TransactionBuilder(source_account, NETWORK_PASSPHRASE, base_fee=100)
        .append_invoke_contract_function_op(
            contract_id=GUARD_ADDRESS,
            function_name="status",
            parameters=[]
        )
        .set_timeout(30)
        .build()
    )
    simulation = server.simulate_transaction(tx)
    print("Simulation status response:", simulation)
    return simulation

def run_heartbeat_loop(interval_seconds=900):
    """
    Periodic keep-alive loop to prevent dead-man switch expiry.
    Interval must be significantly smaller than dms_grace_secs.
    """
    print(f"Starting agent heartbeat monitor for Guard {GUARD_ADDRESS[:8]}...")
    while True:
        try:
            print("Sending agent heartbeat...")
            source_account = server.load_account(source_keypair.public_key)
            tx = (
                TransactionBuilder(source_account, NETWORK_PASSPHRASE, base_fee=10000)
                .append_invoke_contract_function_op(
                    contract_id=GUARD_ADDRESS,
                    function_name="heartbeat",
                    parameters=[]
                )
                .set_timeout(60)
                .build()
            )
            
            # Prepare transaction with Soroban resource declarations
            prepared_tx = server.prepare_transaction(tx)
            prepared_tx.sign(source_keypair)
            
            response = server.send_transaction(prepared_tx)
            print(f"Heartbeat submitted: tx hash {response.get('hash')}")
            
        except Exception as e:
            print(f"Heartbeat failed: {e}")
            
        time.sleep(interval_seconds)

if __name__ == "__main__":
    read_guard_status()
```

---

## Phase 5: Framework Adapters: LangChain & ElizaOS

`stellar-agent-guard-sdk` includes pre-built structural adapters for popular agent frameworks. The adapters intercept actions before the tool body runs.

### 1. LangChain Middleware (`createLangChainGuardMiddleware`)

In LangChain, tool calls are intercepted via `AgentMiddleware.wrapToolCall`. If the guard blocks the call, the tool continuation is **never called**, preventing unauthorized execution:

```ts
import { PreFlightInterceptor, createLangChainGuardMiddleware } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({ ... });

export const guardMiddleware = createLangChainGuardMiddleware({
  interceptor,
  // Map incoming LangChain tool call to a Soroban contract call
  toContractCall: (request) => {
    if (request.toolCall.name === "transfer_stellar_tokens") {
      const { token, to, amount } = request.toolCall.args;
      return {
        contract: String(token),
        fn: "transfer",
        args: [
          new Address(interceptor.guard).toScVal(),
          new Address(String(to)).toScVal(),
          nativeToScVal(BigInt(amount), { type: "i128" }),
        ],
      };
    }
    // Return null for tools that do not move funds
    return null;
  },
  onDecision: (request, decision) => {
    if (!decision.allowed) {
      console.warn(`[GUARD BLOCK] Tool ${request.toolCall.name} blocked: ${decision.reason}`);
    }
  },
});
```

* When blocked, the middleware returns a `LangChainToolMessage` with `status: "error"` containing the contract's block reason.

### 2. ElizaOS Action Validator (`createGuardValidator` / `guardAction`)

ElizaOS gates action execution using `Action.validate`. The adapter wraps `validate` to return `false` if the guard simulation refuses the action:

```ts
import { PreFlightInterceptor, createGuardValidator, guardAction } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({ ... });

// Method A: Guard an entire Action definition
export const transferAction = guardAction(rawTransferAction, {
  interceptor,
  toContractCall: (message, state) => {
    // Extract parameters from message or state
    return {
      contract: "CBLQLJAG...",
      fn: "transfer",
      args: [...],
    };
  },
  onBlocked: (decision) => {
    console.warn(`Eliza action blocked by Guard: ${decision.reason}`);
  },
});

// Method B: Compose into custom validate function
export const customValidator = createGuardValidator({
  interceptor,
  toContractCall: (message, state) => { ... },
});
```

---

## Phase 6: Heartbeat & Dead-Man Switch Dynamics

The dead-man switch provides an automated failsafe against abandoned or looping agents.

### Operational Mechanics

1. **Keep-Alive Timestamp**: When the agent calls `heartbeat()`, the contract sets:
   ```rust
   last_heartbeat = env.ledger().timestamp();
   ```
2. **Expiration Calculation**: The contract derives expiration dynamically on each call:
   ```rust
   heartbeat_expired = (now - last_heartbeat) > dms_grace_secs;
   ```
3. **Refusal on Expiry**: If `heartbeat_expired == true`, `__check_auth` immediately refuses any spending transaction with reason code `11` (`heartbeat_expired`).
4. **Cadence Recommendation**: Set your heartbeat loop interval to **`dms_grace_secs / 3`** or **`dms_grace_secs / 4`** to prevent network latency or minor ledger close delays from triggering a false freeze.

### Dashboard Verification

When a heartbeat succeeds:
* In [`StatusPanel`](../../components/StatusPanel.tsx):
  * **Last heartbeat**: Updates to show the latest ledger timestamp.
  * **Dead-man switch**: Displays `within grace` with active grace remaining (tone `ok`).
* In [`TelemetryFeed`](../../components/TelemetryFeed.tsx):
  * A new row appears with `Event: Agent heartbeat`, `Decision: —`, `Source: ledger`, and the associated ledger number.

---

## Phase 7: Diagnosing Telemetry: Errors vs. Blocked Calls

The dashboard's [`TelemetryFeed`](../../components/TelemetryFeed.tsx) and [`StatusPanel`](../../components/StatusPanel.tsx) provide transparent real-time observability.

### Understanding Blocked Calls vs. System Errors

| Property | Blocked Decision (`kind: "blocked"`) | System / Runtime Error (`kind: "error"`) |
| :--- | :--- | :--- |
| **What it means** | The Guard firewall operated correctly and intentionally blocked an unauthorized call. | A network, transport, syntax, or unexpected contract trap occurred. |
| **Gas Fee Charged** | **0 stroops** (refused during simulation before broadcast). | None if in simulation; standard inclusion fee if rejected post-broadcast. |
| **Transaction Hash** | **None** (never submitted to the network). | None (if simulation) or failure hash in [`TxHistoryTable`](../../components/TxHistoryTable.tsx). |
| **Telemetry Appearance** | Rendered with `pill danger` displaying the specific reason name. | Rendered in [`ErrorBlock`](../../components/bits.tsx) banner with diagnostic trace. |

### Contract Block Reasons Reference (`GUARD_REASON_CODES`)

When a call is blocked, the Guard returns a specific reason code. The SDK translates these via `explainReason()`:

| Numeric Code | Symbol Name | Meaning | Common Cause & Resolution |
| :---: | :--- | :--- | :--- |
| `1` | `unauthorized` | Signature verification failed in `__check_auth`. | `AGENT_SECRET` does not match the public key registered during `initialize`. |
| `2` | `already_initialized` | `initialize` called on an already configured guard. | Contract is already initialized. Do not re-run `initialize`. |
| `3` | `not_initialized` | Guard has not been initialized with admin/agent keys. | Complete Step 6 in Deploy Panel before running agent. |
| `10` | `admin_frozen` | Account is frozen by operator panic button. | Operator clicked "Freeze this account". Reversible by `unfreeze()`. |
| `11` | `heartbeat_expired` | Dead-man switch grace period elapsed. | Agent heartbeat loop stopped or was delayed. Send `heartbeat()`. |
| `12` | `no_policy` | Guard has no policy installed (default-deny). | Install policy rules via `/configure` before agent transactions. |
| `13` | `paused` | Policy switch is set to paused. | Operator paused the account in policy settings. |
| `14` | `outside_active_window` | Current ledger time is outside `active_from` / `active_until`. | Adjust policy active execution window. |
| `20` | `asset_not_allowed` | Target SAC token is not in `assets` allowlist. | Add the token contract ID to policy allowlist. |
| `21` | `recipient_not_allowed` | Destination address is not in `recipients` allowlist. | Add recipient `G...` to policy allowlist or enable `allow_any_recipient`. |
| `22` | `per_tx_cap_exceeded` | Transfer amount exceeds `per_tx_cap`. | Amount requested is higher than allowed per single transaction. |
| `23` | `window_cap_exceeded` | Cumulative spend exceeds `window_cap` within `window_secs`. | Agent spent its rolling limit. Wait for older window entries to expire. |
| `24` | `protocol_not_allowed` | Contract call target is not in `protocols` allowlist. | Allowlist contract in policy. |
| `25` | `function_not_allowed` | Contract function name is not permitted. | Allowlist specific function name in protocol rule. |

---

## Phase 8: Troubleshooting

### 1. `heartbeat()` fails with `unauthorized` (Code 1)
* **Cause**: The keypair loaded into `AGENT_SECRET` does not correspond to the public key registered in `DeployPanel`.
* **Fix**: Ensure the hex string supplied to `initialize` was created from `StrKey.decodeEd25519PublicKey(agentKeypair.publicKey())`. If necessary, execute `rotate_agent_key` from the admin wallet.

### 2. Pre-flight returns `PreFlightUndeterminedError`
* **Cause**: The contract call failed for a reason unrelated to the policy check (e.g., recipient account lacks a trustline for the asset, insufficient token balance, or invalid contract ID).
* **Fix**: Inspect the simulation error detail. Ensure the Guard contract address holds sufficient SAC token balance (`mint` or `transfer` funds to the Guard address).

### 3. Blocked calls do not appear in the Dashboard Telemetry Feed
* **Cause**: In Soroban, blocked transactions never reach ledger history. They only appear in telemetry if captured via simulation diagnostics from the console or sent via a local monitoring hook.
* **Fix**: Check `TelemetryFeed.tsx` notice: *"Refused decisions cannot reach this feed from the ledger."* The feed marks simulation refusals as `diagnostic`. For production runtime visibility, log `decision.reason` in your agent application.

### 4. Post-inclusion failure: `scecExceededLimit`
* **Cause**: Stale-ledger resource declaration when consecutive writes occur on the same ledger sequence.
* **Fix**: `stellar-agent-guard-sdk`'s `invoke()` has built-in retry handling for `isStaleLedgerResourceFailure`. If handling transactions manually, re-simulate against the latest ledger and resubmit.
