# 1. Zero-Server Client-Only Architecture

Date: 2026-09-25

## Status

Accepted

## Context

The Stellar Agent Guard Dashboard provides a user interface for monitoring and managing autonomous agent interactions on the Stellar network. A key architectural decision is how the dashboard interfaces with the network and manages user data and secrets.

## Decision

We will implement the dashboard as a 100% static client-side web application without a backend server, proxy, or relational database. The application connects directly to the Stellar network via Soroban RPC.

## Consequences

### Positive

- **Security:** There is no centralized key custody. Private keys remain exclusively on the user's device, significantly mitigating the risk of large-scale credential theft.
- **Reduced Attack Surface:** Eliminating a backend server removes traditional server-side vulnerabilities, proxy compromises, and database-level attack vectors entirely.
- **Direct Network Interaction:** The Stellar protocol sets the necessary CORS headers by default, enabling the client browser to directly query the Soroban RPC without requiring an intermediary backend proxy.
- **Deployment Simplicity:** The application can be hosted cheaply and reliably on any static asset hosting provider or CDN.

### Negative

- **Event Polling Latency:** Without a dedicated server-side indexing database to aggregate data and push real-time updates via WebSockets, the dashboard must rely on polling the Soroban RPC. This can introduce latency and limit querying performance for complex historical event aggregation.

### Neutral

- Architectural constraints require all application logic, RPC interaction, and state management to reside in the frontend browser environment.
