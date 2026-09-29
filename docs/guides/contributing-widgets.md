# Contributing Widgets and Panels

This guide covers everything you need to know to create, style, test, and integrate new dashboard panels and widgets into `stellar-agent-guard-dashboard`.

---

## Overview

`stellar-agent-guard-dashboard` is an operator console for [`stellar-agent-guard`](https://github.com/aigbagbobila/stellar-agent-guard-contracts). It is a pure client-side Next.js application that holds no private keys and runs no server runtime. Every number displayed in the dashboard is read directly on-chain from Soroban RPC or derived from verified telemetry, and every write is signed by the operator's own wallet in Freighter.

### What Dashboard Widgets and Panels Are

In this architecture:

* **Panels** (e.g., [`StatusPanel.tsx`](../../components/StatusPanel.tsx), [`TelemetryFeed.tsx`](../../components/TelemetryFeed.tsx), [`PanicPanel.tsx`](../../components/PanicPanel.tsx), [`TxHistoryTable.tsx`](../../components/TxHistoryTable.tsx), [`DeployPanel.tsx`](../../components/DeployPanel.tsx)) are top-level functional cards rendered within pages. They encapsulate a distinct operational domain, such as account health, telemetry monitoring, policy management, or emergency controls.
* **Widgets** are specialized, modular components designed to display specific guard metrics, telemetry visualizations, or interactive controls. They can exist as standalone panels or as subcomponents embedded within panels.

### Architectural Fit

The dashboard follows a unidirectional, context-driven architecture:

```
                      ┌─────────────────────────────────────────┐
                      │              Soroban RPC                │
                      │ (Ledger reads, getEvents, simulations)  │
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │              GuardProvider              │
                      │  - Automatic snapshot polling (15s)     │
                      │  - Cursor-based telemetry polling (5s)  │
                      │  - Cross-tab coordination (TabSync)     │
                      │  - Connected wallet state (Freighter)   │
                      └────────────────────┬────────────────────┘
                                           │
                                           ▼ useGuard()
        ┌───────────────────┬──────────────┴──────┬───────────────────┐
        ▼                   ▼                     ▼                   ▼
┌───────────────┐   ┌───────────────┐     ┌───────────────┐   ┌───────────────┐
│  StatusPanel  │   │ TelemetryFeed │     │  PanicPanel   │   │ Custom Widget │
│ (On-chain UI) │   │ (Event stream)│     │ (Freeze/Rev)  │   │ (New Feature) │
└───────┬───────┘   └───────┬───────┘     └───────┬───────┘   └───────┬───────┘
        │                   │                     │                   │
        └───────────────────┴──────────┬──────────┴───────────────────┘
                                       ▼
                       ┌───────────────────────────────┐
                       │  components/bits.tsx & Tokens │
                       │ (Stat, Read, AmountDisplay,   │
                       │  ErrorBlock, CSS variables)   │
                       └───────────────────────────────┘
```

### When to Create a New Widget vs. Modify an Existing Component

* **Create a new widget or panel when**:
  * You are adding a distinct functional capability (e.g., rate-limit monitoring, recipient activity breakdown, gas consumption analytics).
  * The feature has its own lifecycle, telemetry filters, or user interactions.
  * You want to keep existing panels focused and maintain high cohesion.
* **Modify an existing component when**:
  * You are fixing bugs or improving accuracy in how an existing on-chain field is rendered.
  * You are adding complementary metadata directly related to an existing panel's core responsibility (e.g., adding an extra stat to [`StatusPanel.tsx`](../../components/StatusPanel.tsx)).
  * You are refining styling or accessibility for existing controls.

---

## Before You Start

### Prerequisites

* **Node.js**: `>= 24.0.0` (as declared in [`package.json`](../../package.json) `"engines"`).
* **npm**: `>= 10.0.0` (or the version bundled with Node 24).
* **Freighter Wallet**: Browser extension configured for Stellar Testnet for manual verification.

### Local Development Commands

Before authoring code, familiarize yourself with the project scripts:

```bash
# Install exact dependencies
npm ci

# Start local Next.js dev server
npm run dev

# Start local dev server in Demo Mode (static fixtures, zero RPC/wallet needed)
npm run dev:demo

# Typecheck with TypeScript (tsc --noEmit)
npm run typecheck

# Lint with ESLint
npm run lint

# Run the unit test suite (Node's native test runner via tsx)
npm test

# Production build validation
npm run build
```

> [!IMPORTANT]
> The CI gate enforces: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and an enforcement-scope consistency check (`tests/unit/scopeStatement.test.ts`). Every contribution must pass all four checks locally.

---

## Directory Structure

The repository maintains a flat and purposeful structure. Only real, existing paths are documented below:

```
stellar-agent-guard-dashboard/
├── app/                        # Next.js App Router root
│   ├── configure/              # /configure route
│   │   └── page.tsx            # ConfigurePage (DeployPanel, PolicyForm)
│   ├── globals.css             # Design tokens, variables, utility classes, a11y rules
│   ├── layout.tsx              # RootLayout (Shell, Header, Tabs, AriaAnnouncer, PwaRegistrar)
│   └── page.tsx                # ConsolePage (WalletBar, StatusPanel, TxHistoryTable, TelemetryFeed, PanicPanel)
├── components/                 # Client UI components, panels, and widgets
│   ├── AriaAnnouncer.tsx       # Live region announcer for screen readers (polite & assertive)
│   ├── DemoBadge.tsx           # Banner displayed when running in demo fixture mode
│   ├── DeployPanel.tsx         # Deploy and contract initialization workflow panel
│   ├── GuardProvider.tsx       # Core context provider holding wallet, snapshot, and telemetry
│   ├── PanicPanel.tsx          # Emergency freeze / unfreeze modal and confirmation flow
│   ├── PolicyForm.tsx          # Policy draft editor and submission panel
│   ├── PwaRegistrar.tsx        # Service worker registration component
│   ├── StatusPanel.tsx         # Live on-chain status, policy, and rolling window display
│   ├── TelemetryFeed.tsx       # Live cursor-polled telemetry table (ledger & diagnostic)
│   ├── TxHistoryTable.tsx      # Browser-stored transaction history with CSV export
│   ├── WalletBar.tsx           # Guard instance selector and Freighter wallet connection
│   └── bits.tsx                # Reusable design tokens, primitives, formatters, and notices
├── docs/                       # Project documentation and GitBook guides
│   ├── concepts/               # Architectural concepts (no mock state, Freighter, dual-freeze)
│   ├── guides/                 # Step-by-step developer and contributor guides
│   ├── runbooks/               # Operator incident and routine runbooks
│   └── screens/                # UI screen specifications
├── lib/guard/                  # Pure TypeScript domain logic, Soroban RPC, and helpers
│   ├── chain.ts                # RPC reads, simulation, verifyWasmIdentity, predictContractId
│   ├── demoFixtures.ts         # Static demo fixtures and synthetic telemetry generator
│   ├── formatters.ts           # Exact BigInt amount formatting (formatStroops, formatStroopsWithUnit)
│   ├── guardOps.ts             # High-level operations (readGuardSnapshot, deployGuard, freezeGuard)
│   ├── instance.ts             # Guard instance storage and validation
│   ├── network.ts              # Network configuration, testnet RPC URL, pinned artifact hash
│   ├── policyForm.ts           # Policy draft parsing and ScVal serialization
│   ├── submit.ts               # Wallet signing, simulation enforcement, tx submission
│   ├── tabSync.ts              # Cross-tab state synchronization via BroadcastChannel
│   ├── telemetry.ts            # GuardFeed cursor-based reader over Soroban getEvents
│   ├── txHistory.ts            # Client-side transaction history storage in localStorage
│   ├── useAnnounce.ts          # Screen reader announcement queue hook and utilities
│   └── wallet.ts               # Freighter wallet connection and signature wrappers
├── tests/
│   ├── fixtures/               # Test fixtures (phase3-proof.json, etc.)
│   └── unit/                   # Unit test suite (*.test.ts)
│       ├── a11yAudit.test.ts   # Automated axe-core WCAG 2.1 AA scans
│       ├── domHarness.ts       # JSDOM and React test mounting harness
│       ├── formatters.test.ts  # BigInt formatter assertions
│       └── ...                 # Component and logic unit tests
├── CONTRIBUTING.md             # Organization contributing guide and local gates
├── package.json                # Project dependencies and script declarations
├── SPEC.md                     # Engineering specification
└── tsconfig.json               # TypeScript configuration
```

---

## Component Conventions

When authoring a new panel or widget, follow these established project patterns:

### 1. File & Component Naming

* **File Name**: PascalCase with `.tsx` extension in `components/` (e.g., `components/RateLimitWidget.tsx`).
* **Component Name**: PascalCase export matching the file name:
  ```tsx
  export function RateLimitWidget() { ... }
  ```
* **Client Directive**: Add `"use client";` as the very first line of the file.

### 2. Component Structure

Organize component files in standard order:

```tsx
"use client";

// 1. React & framework imports
import { useMemo, useState } from "react";

// 2. SDK and external library imports
import type { GuardEvent } from "stellar-agent-guard-sdk";

// 3. Context & hooks
import { useGuard } from "./GuardProvider.tsx";
import { useAnnounce } from "../lib/guard/useAnnounce.ts";

// 4. Design tokens & reusable primitives from bits.tsx
import { AmountDisplay, ErrorBlock, Read, Stat, relativeTime, short } from "./bits.tsx";

// 5. Types & interfaces
export interface RateLimitWidgetProps {
  compact?: boolean;
}

// 6. Main component export
export function RateLimitWidget({ compact = false }: RateLimitWidgetProps) {
  // Hook consumption
  // Local state
  // Derived data / useMemo
  // Render JSX (.panel, .row, .grid, etc.)
}

// 7. Local helper functions (pure, deterministic)
function formatMetric(...) { ... }
```

### 3. State Management Principles

* **Global On-Chain State**: Consume exclusively via `useGuard()`. Never fetch contract state independently in widgets if `readGuardSnapshot` already provides it.
* **Local UI State**: Use `useState` only for transient UI states (e.g., modal visibility, search inputs, pagination, view toggles).
* **Never Duplicate Context State**: Do not copy snapshot data or telemetry events into local `useState`. Derive values dynamically using `useMemo`.

---

## Using `GuardProvider` and `useGuard()`

`GuardProvider` (`components/GuardProvider.tsx`) manages all client-side state. It polls on-chain state every 15 seconds (`SNAPSHOT_INTERVAL_MS = 15_000`) and event telemetry every 5 seconds (`FEED_INTERVAL_MS = 5_000`).

### The `GuardContextValue` Interface

Calling `useGuard()` returns:

```ts
interface GuardContextValue {
  server: rpc.Server;                                   // Soroban RPC server instance
  wallet: ConnectedWallet | null;                       // Connected Freighter wallet or null
  walletError: string | null;                           // Connection error message
  connecting: boolean;                                  // True while connecting wallet
  connect: () => Promise<void>;                         // Connect Freighter
  disconnect: () => void;                               // Disconnect Freighter
  signer: () => WalletSigner;                           // Signer callback for writes
  instances: GuardInstance[];                           // Known/saved guard instances
  guard: string;                                        // Currently active contract address (C...)
  selectGuard: (guard: string) => void;                 // Switch active guard
  addInstance: (guard: string, label: string) => void;  // Add new guard address
  snapshot: GuardSnapshot | null;                       // Polled on-chain state snapshot
  snapshotError: string | null;                         // Transport or RPC failure message
  refreshing: boolean;                                  // True while re-reading snapshot
  refresh: () => Promise<void>;                         // Manual trigger to re-read chain
  events: GuardEvent[];                                 // Combined telemetry events (max 250)
  feed: {                                               // Telemetry feed status
    watching: boolean;
    latestLedger: number | null;
    error: string | null;
    lastPolledAt: string | null;
  };
  startWatching: () => void;                            // Start polling getEvents
  stopWatching: () => void;                             // Stop polling getEvents
  clearEvents: () => void;                              // Clear events from local memory
  pushEvents: (events: GuardEvent[]) => void;           // Add diagnostic events
  notifyTabs: (type: TabSyncEventType, options?: ...) => void; // Sync other browser tabs
}
```

### The `GuardSnapshot` Structure

When `snapshot` is not null, it provides four independent read results:

```ts
export interface GuardSnapshot {
  guard: string;
  fetchedAt: string;                         // ISO timestamp of last read
  status: ReadResult<GuardStatus>;           // Admin freeze, dead-man switch, heartbeat
  policy: ReadResult<PolicyConfig | null>;   // Installed policy caps, allowlists, pauses
  window: ReadResult<WindowState | null>;    // Rolling-window spend history
  identity: ReadResult<WasmIdentity>;        // Contract bytecode verification against pin
}
```

Each field is wrapped in a `ReadResult<T>`:
```ts
export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

### Consuming Snapshot Data with `<Read>`

Never unwrap `result.value` without checking `result.ok`. Use the `<Read>` component from `components/bits.tsx`:

```tsx
import { Read, Stat } from "./bits.tsx";

<Read
  result={snapshot.status}
  label="status()"
  render={(status) => (
    <Stat
      label="Admin freeze"
      tone={status.admin_frozen ? "danger" : "ok"}
      value={status.admin_frozen ? "FROZEN" : "clear"}
    />
  )}
/>
```

If the read fails, `<Read>` automatically renders an accessible `<ErrorBlock>` stating which read failed and why. It will never render a misleading zero or empty state.

---

## Subscribing to Telemetry Events

Telemetry in `stellar-agent-guard` comes from two distinct sources:

1. **Committed Ledger Events** (`source: "ledger"`): Allowed authorizations, heartbeats, and admin operations (`policy_set`, `frozen`, `unfrozen`). These are polled using the SDK's `GuardTelemetryListener` via `getEvents` with a cursor.
2. **Diagnostic Events** (`source: "diagnostic"`): Blocked/refused decisions. Because Soroban rolls back transaction events when a contract returns `Err`, refused calls *never* commit to the ledger. Refusals initiated by this console are captured during simulation diagnostics and fed via `pushEvents`.

### Accessing Events in a Widget

All deduplication, pagination, and cursor management are handled by `GuardProvider`. Widgets simply consume `events`:

```tsx
export function MyTelemetryWidget() {
  const { events, feed, startWatching, stopWatching } = useGuard();

  // Filter or aggregate events using useMemo
  const blockedDecisions = useMemo(() => {
    return events.filter(
      (e) => e.kind === "auth_checked" && e.decision?.result === "blocked"
    );
  }, [events]);

  return (
    <div className="panel">
      <h2>Blocked Activity ({blockedDecisions.length})</h2>
      {/* Render event details */}
    </div>
  );
}
```

### Avoiding Stale Subscriptions and Re-render Storms

* **Deduplication**: `GuardProvider` maintains a `seenRef` set with compound event keys (`source|txHash|ledger|topic|result|reason|data`). Events are deduplicated across polls.
* **Memoization**: Always wrap calculations over `events` in `useMemo(..., [events])`.
* **Bounded History**: The provider caps history to the 250 most recent events (newest first). Do not assume `events` is an infinite log.

---

## Design Tokens

All styling adheres to the CSS variables in [`app/globals.css`](../../app/globals.css) and the reusable building blocks in [`components/bits.tsx`](../../components/bits.tsx). Contributors must reuse these existing tokens rather than introducing custom color codes or uncoordinated utilities.

### 1. Palette & CSS Variables

| Variable | Hex Value | Purpose |
| :--- | :--- | :--- |
| `--bg` | `#0a0d12` | Root page background |
| `--panel` | `#12161d` | Card & panel background (`.panel`) |
| `--panel-2` | `#171c25` | Nested stat card background (`.stat`, active tabs) |
| `--line` | `#242c38` | Borders and dividers |
| `--text` | `#e6ebf2` | Primary body text |
| `--muted` | `#8b98ab` | Secondary text, field labels, metadata (`.muted`, `.tiny`) |
| `--accent` | `#4da3ff` | Interactive highlights, links, focus ring outline |
| `--ok` | `#37d67a` | Confirmed/success states, allowed decisions, clear flags |
| `--warn` | `#ffb020` | Notices, expired heartbeats, paused states, demo flags |
| `--danger` | `#ff5c5c` | Admin freeze, blocked authorizations, failed operations |
| `--mono` | `ui-monospace, ...` | Addresses, hashes, stroop amounts, bytecode metadata |

### 2. Layout & Utility Classes

* `.panel`: Container card with rounded corners (`border-radius: 11px`), padding (`16px 18px`), and border `--line`.
* `.panel h2`: Section header, uppercase, letter-spaced, `--muted` font.
* `.row`: Horizontal flexbox with `gap: 12px` and `align-items: center`.
* `.grid`: Responsive CSS grid (`grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))`).
* `.split`: Two-column grid collapsing to single-column on screens `< 720px`.
* `.pill`: Inline status badge. Variants: `.pill.ok`, `.pill.warn`, `.pill.danger`.
* `.mono`: Formatted with `--mono` and `word-break: break-all`.
* `.tiny`: Reduced font size (`12px`).
* `.scrolly`: Scrollable container with `max-height: 340px` and `overflow-y: auto`.

### 3. Reusable Components in `components/bits.tsx`

| Component | Props | Description |
| :--- | :--- | :--- |
| `<Stat />` | `label`, `value`, `note?`, `tone?` (`"ok"` \| `"warn"` \| `"danger"`) | Standard metric card inside a `.grid`. |
| `<Read />` | `result: ReadResult<T>`, `label: string`, `render: (val: T) => ReactNode` | Strictly renders value or `<ErrorBlock>`. |
| `<ErrorBlock />` | `title: string`, `detail: string` | Formatted error banner with red accent border. |
| `<AmountDisplay />`| `stroops: bigint \| number \| string`, `symbol?`, `decimals?` | Accessible toggle button between human-readable and raw stroops. |
| `<ScopeNotice />` | `compact?: boolean` | Standardized enforcement boundary notice. |
| `<OutcomeList />` | `steps: Array<{ label, result }>` | Transaction progress and outcome log. |
| `short()` | `(val: string, head = 6, tail = 4)` | Truncates addresses and hashes with ellipsis (`…`). |
| `relativeTime()`| `(iso: string \| null)` | Converts ISO timestamps to relative `"Xs ago"` / `"Xm ago"`. |
| `starLink()` | `(hash: string)` | Clickable link to StellarExpert Testnet explorer. |

---

## Accessibility

All components must comply with WCAG 2.1 AA standards. Automated audits (`axe-core`) run in CI via [`tests/unit/a11yAudit.test.ts`](../../tests/unit/a11yAudit.test.ts).

### 1. Semantic HTML & Labeling

* Use native `<button type="button">` for interactive controls. Never attach click handlers to bare `<div>` or `<span>` elements.
* Every form control must have an associated label. Use `<label className="field"><span className="lbl">...</span><input ... /></label>` or specify `aria-label`.
* Use appropriate heading hierarchy (`<h2>` for panel titles, `<h3>` for subsections).

### 2. High-Visibility Focus Indicators

All interactive elements inherit the global `:focus-visible` rule from `globals.css`:
```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(77, 163, 255, 0.3);
}
```
Never override or remove `outline: none` without providing an equal or higher contrast focus ring.

### 3. Screen Reader Announcements (`useAnnounce`)

Use `useAnnounce()` from [`lib/guard/useAnnounce.ts`](../../lib/guard/useAnnounce.ts) to announce asynchronous events or action outcomes:

```tsx
import { useAnnounce } from "../lib/guard/useAnnounce.ts";

export function ExportButton() {
  const announce = useAnnounce();

  const handleExport = () => {
    // perform export
    announce("Exported 15 events to CSV", "polite");
  };

  return <button onClick={handleExport}>Export</button>;
}
```

* Use `"polite"` (default) for routine status changes.
* Use `"assertive"` exclusively for critical alerts (e.g., emergency freeze confirmation).

### 4. Color-Independent Communication

Never rely on color alone to communicate state:
* Pair `--ok` with the word `"clear"` or `"allowed"`.
* Pair `--danger` with `"FROZEN"` or `"blocked"`.
* Pair `--warn` with `"PAUSED"` or `"expired"`.

---

## Data and Error Handling Standards

### 1. No Mock Data

> [!CAUTION]
> Hardcoding mock numbers, fallback balances, or simulated events inside production widget code is strictly prohibited.

* **No Fallback Zeros**: Never write `value ?? 0` or `snapshot?.status?.value || defaultStatus`. If an on-chain read fails or is pending, show the loading indicator or `<ErrorBlock>`. A fallback zero turns a network outage into what looks like an empty policy or a zero-balance account.
* **Demo Mode Isolation**: Synthetic data exists solely in [`lib/guard/demoFixtures.ts`](../../lib/guard/demoFixtures.ts). It activates only when explicitly requested (`NEXT_PUBLIC_DEMO_MODE=true` or `?demo=true`). Production widgets must remain completely agnostic of demo mode and rely purely on the data provided by `useGuard()`.

### 2. No Floating-Point Amounts

Stellar amounts are denominated in 7-decimal integer stroops (`1 XLM = 10,000,000 stroops`). JavaScript's IEEE 754 floating-point `Number` loses precision on large 64-bit integer values.

* **Always use `bigint`** for amounts, spend caps, and ledger sequence numbers.
* Perform integer arithmetic using BigInt:
  ```ts
  // Correct
  const percentage = cap > 0n ? Number((totalSpent * 100n) / cap) : 0;

  // WRONG - NEVER DO THIS:
  const percentage = (Number(totalSpent) / Number(cap)) * 100;
  ```
* For UI display, always use [`AmountDisplay`](../../components/bits.tsx) or formatters from [`lib/guard/formatters.ts`](../../lib/guard/formatters.ts):
  ```tsx
  <AmountDisplay stroops={policy.per_tx_cap} symbol="XLM" decimals={7} />
  ```

### 3. Strict Error States

Every widget must explicitly account for four distinct UI states:

1. **Loading State**: When data is being fetched (`!snapshot && !snapshotError`).
2. **Error State**: When RPC fails (`snapshotError` or `!result.ok`). Render `<ErrorBlock>`.
3. **Empty State**: When on-chain data is empty (e.g., zero events recorded, no spend in rolling window, no policy installed). Render a descriptive message.
4. **Success / Populated State**: When valid on-chain data is present.

---

## Step-by-Step: Creating a New Widget

In this walkthrough, we will create a realistic widget: **`SpendingSummaryWidget`**. This widget displays rolling-window spend utilization against the policy cap, checks heartbeat freshness, and summarizes recent blocked telemetry events.

### Step 1: Create the Component File

Create `components/SpendingSummaryWidget.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import { useGuard } from "./GuardProvider.tsx";
import { AmountDisplay, ErrorBlock, Read, Stat, relativeTime } from "./bits.tsx";

export interface SpendingSummaryWidgetProps {
  /** Optional title override */
  title?: string;
}

export function SpendingSummaryWidget({ title = "Spending & Policy Summary" }: SpendingSummaryWidgetProps) {
  const { snapshot, snapshotError, refreshing, refresh, events, feed } = useGuard();

  // Aggregate recent blocked events from telemetry
  const blockedCount = useMemo(() => {
    return events.filter(
      (e) => e.kind === "auth_checked" && e.decision?.result === "blocked"
    ).length;
  }, [events]);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <div className="row">
          {refreshing && <span className="tiny muted">Refreshing…</span>}
          <button
            type="button"
            className="secondary"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh spending metrics"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* 1. Global snapshot error */}
      {snapshotError && (
        <ErrorBlock
          title="Could not read on-chain spending data"
          detail={snapshotError}
        />
      )}

      {/* 2. Loading state */}
      {!snapshot && !snapshotError && (
        <p className="tiny muted">Reading on-chain policy and spend window…</p>
      )}

      {/* 3. Populated state */}
      {snapshot && (
        <>
          <div className="grid" style={{ marginTop: 12 }}>
            {/* Policy Per-Tx Cap */}
            <Read
              result={snapshot.policy}
              label="policy().per_tx_cap"
              render={(policy) => {
                if (!policy) {
                  return <Stat label="Per-Tx Cap" value="No policy" note="Account default-deny" />;
                }
                return (
                  <Stat
                    label="Per-Tx Cap"
                    value={
                      policy.per_tx_cap === 0n ? (
                        "Uncapped"
                      ) : (
                        <AmountDisplay stroops={policy.per_tx_cap} />
                      )
                    }
                    note="Max allowed per transaction"
                  />
                );
              }}
            />

            {/* Rolling Window Utilization */}
            <Read
              result={snapshot.window}
              label="Window spend"
              render={(window) => {
                const policy = snapshot.policy.ok ? snapshot.policy.value : null;
                const total = window?.total ?? 0n;
                const cap = policy?.window_cap ?? 0n;
                const pct = cap > 0n ? Number((total * 100n) / cap) : null;

                return (
                  <Stat
                    label="Window Spent"
                    value={<AmountDisplay stroops={total} />}
                    note={
                      pct !== null
                        ? `${pct}% of ${cap > 0n ? "window cap" : "uncapped"}`
                        : "No window cap active"
                    }
                    tone={pct !== null && pct > 90 ? "warn" : "ok"}
                  />
                );
              }}
            />

            {/* Telemetry Blocked Decisions */}
            <Stat
              label="Blocked Calls"
              value={blockedCount.toString()}
              tone={blockedCount > 0 ? "danger" : "ok"}
              note={
                feed.watching
                  ? `From ${events.length} tracked events`
                  : "Start telemetry feed to watch"
              }
            />
          </div>

          <p className="tiny muted" style={{ marginTop: 10 }}>
            Snapshot read {relativeTime(snapshot.fetchedAt)}. All figures verified against Soroban RPC.
          </p>
        </>
      )}
    </div>
  );
}
```

### Step 2: Integrate into the Dashboard

Open [`app/page.tsx`](../../app/page.tsx) and place your new widget inside `<GuardProvider>`:

```tsx
import { GuardProvider } from "../components/GuardProvider.tsx";
import { WalletBar } from "../components/WalletBar.tsx";
import { StatusPanel } from "../components/StatusPanel.tsx";
import { SpendingSummaryWidget } from "../components/SpendingSummaryWidget.tsx";
import { TxHistoryTable } from "../components/TxHistoryTable.tsx";
import { TelemetryFeed } from "../components/TelemetryFeed.tsx";
import { PanicPanel } from "../components/PanicPanel.tsx";
import { ScopeNotice } from "../components/bits.tsx";

export default function ConsolePage() {
  return (
    <GuardProvider>
      <WalletBar />
      <StatusPanel />
      <SpendingSummaryWidget />
      <TxHistoryTable />
      <PanicPanel />
      <TelemetryFeed />
      <ScopeNotice compact />
    </GuardProvider>
  );
}
```

---

## Unit Test Example

Unit tests in this project use Node's built-in test runner (`node:test`) and strict assertions (`node:assert/strict`). For React component rendering, use the shared JSDOM harness in [`tests/unit/domHarness.ts`](../../tests/unit/domHarness.ts).

Create `tests/unit/spendingSummaryWidget.test.ts`:

```ts
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { ReactElement } from "react";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { SpendingSummaryWidget } from "../../components/SpendingSummaryWidget.tsx";
import { GuardContext } from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";

// 1. Install JSDOM globals before importing React or DOM libraries
installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

// 2. Helper to construct a typed mock GuardContextValue
function createMockContext(overrides: Partial<React.ComponentProps<typeof GuardContext.Provider>["value"]> = {}) {
  return {
    server: {} as any,
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => { throw new Error("not implemented"); },
    instances: [],
    guard: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    selectGuard: () => {},
    addInstance: () => {},
    snapshot: null,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    events: [],
    feed: { watching: true, latestLedger: 1000, error: null, lastPolledAt: new Date().toISOString() },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
    ...overrides,
  };
}

// 3. Render helper wrapped in GuardContext.Provider
interface RenderResult {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function renderWidget(contextValue: ReturnType<typeof createMockContext>): Promise<RenderResult> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;

  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value: contextValue },
        react.createElement(SpendingSummaryWidget)
      )
    );
  });

  // Allow effects to settle
  await act(async () => {
    await sleep(20);
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe("SpendingSummaryWidget", () => {
  it("renders loading state when snapshot is null and no error", async () => {
    const ctx = createMockContext({ snapshot: null, snapshotError: null });
    const { container, unmount } = await renderWidget(ctx);
    try {
      assert.ok(container.textContent?.includes("Reading on-chain policy and spend window…"));
    } finally {
      await unmount();
    }
  });

  it("renders error state when snapshotError is set", async () => {
    const ctx = createMockContext({ snapshot: null, snapshotError: "Network timeout connecting to Soroban RPC" });
    const { container, unmount } = await renderWidget(ctx);
    try {
      assert.ok(container.textContent?.includes("Could not read on-chain spending data"));
      assert.ok(container.textContent?.includes("Network timeout connecting to Soroban RPC"));
    } finally {
      await unmount();
    }
  });

  it("renders populated snapshot with BigInt amounts", async () => {
    const mockSnapshot: GuardSnapshot = {
      guard: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      fetchedAt: new Date().toISOString(),
      status: {
        ok: true,
        value: {
          has_policy: true,
          admin_frozen: false,
          heartbeat_expired: false,
          last_heartbeat: 100n,
          now: 110n,
        },
      },
      policy: {
        ok: true,
        value: {
          per_tx_cap: 50_000_000n, // 5 XLM
          window_cap: 200_000_000n, // 20 XLM
          window_secs: 3600n,
          assets: [],
          recipients: [],
          allow_any_recipient: true,
          protocols: [],
          paused: false,
          active_from: 0n,
          active_until: 0n,
          dms_grace_secs: 300n,
        },
      },
      window: {
        ok: true,
        value: {
          total: 100_000_000n, // 10 XLM (50%)
          entries: [{ ts: 105n, amount: 100_000_000n }],
        },
      },
      identity: {
        reportedWasmHash: "abc",
        fetchedSha256: "abc",
        bytes: 1024,
        match: true,
      },
    };

    const ctx = createMockContext({ snapshot: mockSnapshot });
    const { container, unmount } = await renderWidget(ctx);
    try {
      // Per-Tx Cap should be formatted
      assert.ok(container.textContent?.includes("5.0000000 XLM"));
      // Window spent should be formatted
      assert.ok(container.textContent?.includes("10.0000000 XLM"));
      // Percentage calculation verified
      assert.ok(container.textContent?.includes("50% of window cap"));
    } finally {
      await unmount();
    }
  });

  it("accurately counts blocked telemetry events", async () => {
    const mockEvents: GuardEvent[] = [
      {
        kind: "auth_checked",
        topic: "auth_checked",
        source: "diagnostic",
        contractId: "CAAA",
        ledger: null,
        ledgerClosedAt: null,
        transactionHash: null,
        decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
        data: {},
      },
      {
        kind: "auth_checked",
        topic: "auth_checked",
        source: "ledger",
        contractId: "CAAA",
        ledger: 1001,
        ledgerClosedAt: null,
        transactionHash: "tx1",
        decision: { result: "allowed", reason: null, source: "ledger" },
        data: {},
      },
      {
        kind: "auth_checked",
        topic: "auth_checked",
        source: "diagnostic",
        contractId: "CAAA",
        ledger: null,
        ledgerClosedAt: null,
        transactionHash: null,
        decision: { result: "blocked", reason: "window_cap_exceeded", source: "diagnostic" },
        data: {},
      },
    ];

    const ctx = createMockContext({
      events: mockEvents,
      snapshot: {
        guard: "CAAA",
        fetchedAt: new Date().toISOString(),
        status: { ok: true, value: { has_policy: true, admin_frozen: false, heartbeat_expired: false, last_heartbeat: 0n, now: 0n } },
        policy: { ok: true, value: null },
        window: { ok: true, value: null },
        identity: { reportedWasmHash: null, fetchedSha256: "", bytes: 0, match: false },
      },
    });

    const { container, unmount } = await renderWidget(ctx);
    try {
      // 2 blocked decisions out of 3 events
      const blockedStat = container.querySelector(".stat .danger");
      assert.ok(blockedStat, "Blocked calls stat must carry danger tone");
      assert.equal(blockedStat?.textContent?.trim(), "2");
      assert.ok(container.textContent?.includes("From 3 tracked events"));
    } finally {
      await unmount();
    }
  });
});
```

---

## Validation Checklist Before Submitting a PR

Before opening a pull request, run all verification commands locally:

1. **Typecheck**:
   ```bash
   npm run typecheck
   ```
   Ensure zero TypeScript compilation errors (`tsc --noEmit`).

2. **Lint**:
   ```bash
   npm run lint
   ```
   Ensure ESLint passes cleanly with no warnings or errors.

3. **Unit Tests**:
   ```bash
   npm test
   ```
   All tests in `tests/unit/*.test.ts`, including your new widget tests and `scopeStatement.test.ts`, must pass.

4. **Production Build**:
   ```bash
   npm run build
   ```
   Confirm Next.js builds the static production bundle without errors.

5. **Diff Inspection**:
   ```bash
   git status
   git diff
   ```
   * Confirm that no unintended files or dependencies were modified.
   * Verify zero mock data was committed to production code.
   * Confirm all amount calculations use `bigint`.
   * Confirm all buttons and interactive controls have accessible ARIA labels.
