# Introduction

**Stellar Agent Guard Dashboard** is the human operator console for deploying, configuring, monitoring, and emergency-freezing Stellar Agent Guard smart accounts.

## Operator Console Role

Autonomous AI agents run 24/7 executing tasks on Stellar. The operator needs a dedicated interface to:

1. **Define Security Guardrails**: Install per-transaction spend caps, rolling-window limits, and allowlists without editing smart contract code.
2. **Deploy Verified Accounts**: Deploy new guard accounts from cryptographic WASM bytecode verified against on-chain releases.
3. **Monitor Live Enforcement**: Watch real-time `event_auth_checked` telemetry streams from Soroban RPC.
4. **Execute Emergency Panic Freezes**: Immediately freeze a malfunctioning or compromised agent with a single wallet signature, confirmed by re-reading the contract.

## Pure Client-Side Architecture

The dashboard is built with Next.js 16 and deployed as a static client application. It contains no backend server, no database, and no server-side secrets. All state is read live from Soroban RPC, and all state mutations are signed directly by the operator's Freighter wallet.
