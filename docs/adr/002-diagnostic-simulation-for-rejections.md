# 2. Diagnostic Simulation for Rejected Transaction Visibility

Date: 2026-09-25

## Status

Accepted

## Context

In the Stellar Agent Guard Dashboard, one of the primary use cases is to display the policy evaluations and verdicts for autonomous agents. However, when the Guard contract rejects an operation (e.g., policy violation), it returns an error (`Err`) which traps the contract execution. Due to Soroban's atomic rollback semantics, this completely reverts the transaction state.

Consequently, rejected operations do not emit any on-chain events that could be retrieved using standard methods like `getEvents`. This creates a visibility gap in the dashboard where rejected actions appear to have never happened, leaving the user without actionable telemetry regarding why an agent was blocked.

## Decision

We will reconstruct rejection telemetry via read-only `simulateTransaction` diagnostic logs. The dashboard will rely on client-side diagnostic log parsing to display blocked calls in the UI rather than querying committed on-chain events.

## Consequences

### Positive

- **Visibility:** Operators can see exactly why and when an agent action was rejected.
- **Accuracy:** Parsing diagnostic events from `simulateTransaction` allows the UI to surface the specific contract error and context leading up to the `Err` trap.

### Negative

- **Complexity:** Distinguishing between committed on-chain events (`getEvents`) and simulated, local-only diagnostics introduces frontend state management complexity.
- **Transience:** Simulation results are local to the client executing the pre-flight check. They are not permanently stored on the ledger. Unless cached locally, the historical record of rejected operations is lost once the session ends.

### Neutral

- A clear visual distinction must be made in the UI to prevent users from confusing blocked/simulated actions with committed on-chain events.
