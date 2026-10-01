# Policy Configurator (`/configure`)

Interactive no-code form for configuring smart account guardrails:

- **Policy Presets**: One-click archetypes (Strict Micro-Agent, Standard DeFi Bot, High-Throughput Arbitrage), each badged Conservative, Balanced or Permissive. Selecting one asks to confirm before replacing the current draft; placeholder addresses must be replaced before installing.
- **Per-Transaction Spend Cap**: Limits maximum tokens moved in a single call.
- **Rolling Window Cap & Duration**: Enforces spending limits over a rolling time window (seconds).
- **Asset Allowlists**: Enforces accepted SAC tokens.
- **Recipient Allowlists**: Default-deny recipient address list.
- **Protocol & Function Allowlists**: Configures approved contract IDs and method names for arbitrary Soroban calls.
- **Active Execution Windows**: Restricts execution to specific ledger timestamp intervals.
- **Pause Switch**: Global pause switch for routine maintenance.
- **Dead-Man Grace Window**: Configures maximum allowable inactivity period in seconds.
