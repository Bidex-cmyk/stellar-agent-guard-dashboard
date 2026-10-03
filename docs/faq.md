# Frequently Asked Questions (FAQ)

### Can the dashboard execute transfers on behalf of the agent?

No. The dashboard is strictly an operator console for installing security policies, monitoring events, and triggering freezes. The agent's transactions are generated and signed by the autonomous agent runtime using the SDK.

### What happens if I close the browser during a freeze?

The freeze transaction is signed and broadcast on-chain. Once included in a ledger by the Stellar testnet validators, the smart account remains frozen regardless of whether the dashboard is open.

### How do I switch networks?

The current deployment targets Stellar Testnet. Network settings can be inspected in `lib/guard/network.ts`.
