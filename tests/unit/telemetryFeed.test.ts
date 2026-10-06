import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { ReactElement } from "react";
import { GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { withIdentity } from "../mocks/eventFixtures.ts";
import { TelemetryFeed } from "../../components/TelemetryFeed.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";

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

const GUARD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GUARD_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const GUARD_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function event(contractId: string, ledger: number | null, blocked: boolean): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: GUARD_EVENT_TOPICS.authChecked,
    source: blocked ? "diagnostic" : "ledger",
    contractId,
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    transactionHash: blocked ? null : `tx-${contractId.slice(0, 4)}`,
    decision: {
      result: blocked ? "blocked" : "allowed",
      reason: blocked ? "per_tx_cap_exceeded" : null,
      source: blocked ? "diagnostic" : "ledger",
    },
    data: {},
  });
}

/**
 * The merged multi-guard tail: one allowed committed row from Guard A and one
 * blocked diagnostic row from Guard B, so attribution and the chip filter each
 * have something to discriminate.
 */
const FEED_EVENTS = [event(GUARD_A, 100, false), event(GUARD_B, null, true)];

function contextValue(overrides: Record<string, unknown> = {}) {
  return {
    server: new Proxy({}, { get: () => () => Promise.reject(new Error("no network in tests")) }),
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => {
      throw new Error("no signing in feed tests");
    },
    instances: [
      { guard: GUARD_A, label: "Guard A", provenance: "test" },
      { guard: GUARD_B, label: "Guard B", provenance: "test" },
      { guard: GUARD_C, label: "Guard C", provenance: "test" },
    ],
    guard: GUARD_A,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot: null,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    stream: { paused: false, pendingCount: 0, dropped: 0 },
    pauseStream: () => {},
    resumeStream: () => {},
    queryRange: async () => {},
    rangeLabel: null,
    feed: {
      watching: true,
      latestLedger: 100,
      error: null,
      lastPolledAt: new Date().toISOString(),
      guards: [
        { guard: GUARD_A, label: "Guard A" },
        { guard: GUARD_B, label: "Guard B" },
      ],
      capped: 1,
      cappedLabels: ["Guard C"],
    },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
    ...overrides,
  } as any;
}

async function renderFeed(overrides: Record<string, unknown> = {}, events = FEED_EVENTS) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    const element: ReactElement = react.createElement(TelemetryFeed);
    // Two contexts, not one: the panel reads its rows through
    // `GuardEventsContext`, which the provider keeps deliberately separate from
    // the guard session. An `events` field on the guard context would look
    // right and render nothing.
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value: contextValue(overrides) },
        react.createElement(GuardEventsContext.Provider, { value: events }, element),
      ),
    );
  });
  await act(async () => {
    await sleep(40);
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

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("table.events tbody tr"));
}

test("the feed names the guards beyond the cap instead of dropping them silently", async () => {
  const rendered = await renderFeed();
  try {
    const text = rendered.container.textContent ?? "";
    assert.match(text, /1 guard beyond the 5-guard cap is not being tailed/);
    assert.match(text, /Guard C/, "the un-tailed guard is named");
  } finally {
    await rendered.unmount();
  }
});

test("every row carries a guard-attribution chip from the registry label", async () => {
  const rendered = await renderFeed();
  try {
    const table = rendered.container.querySelector("table.events");
    assert.ok(table, "the feed table renders");
    const body = rows(rendered.container);
    assert.equal(body.length, 2);
    const renderedText = body.map((row) => row.textContent ?? "").join(" | ");
    assert.match(renderedText, /Guard A/);
    assert.match(renderedText, /Guard B/);
  } finally {
    await rendered.unmount();
  }
});

test("the guard-chip filter narrows the merged feed without dropping the others", async () => {
  const rendered = await renderFeed();
  try {
    assert.equal(rows(rendered.container).length, 2);

    const chip = Array.from(rendered.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Guard B",
    );
    assert.ok(chip, "a filter chip for Guard B must exist");
    await act(async () => {
      chip.click();
    });

    const filtered = rows(rendered.container);
    assert.equal(filtered.length, 1);
    assert.match(filtered[0]?.textContent ?? "", /Guard B/);
    assert.equal(chip.getAttribute("aria-pressed"), "true");

    // Toggling the chip off restores the untailed rows.
    await act(async () => {
      chip.click();
    });
    assert.equal(rows(rendered.container).length, 2);
  } finally {
    await rendered.unmount();
  }
});
