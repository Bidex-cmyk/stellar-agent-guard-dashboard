/**
 * The blocked-count badge, from event data to the spoken batch.
 *
 * The component is deliberately thin — `lib/guard/blockedEvents.ts` owns the
 * counting and the window — so what is worth asserting here is the wiring: that
 * a buffer full of rows the DOM never shows still produces an exact count, that
 * the count is spoken once when the window closes, and that the badge clears
 * itself at the same moment.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { AriaAnnouncer } from "../../components/AriaAnnouncer.tsx";
import { BlockedEventBadge } from "../../components/BlockedEventBadge.tsx";
import { clearAnnouncements } from "../../lib/guard/useAnnounce.ts";
import { fixtureTxHash, specToGuardEvent } from "../mocks/eventFixtures.ts";

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

const TEST_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BASE_TIME = Date.UTC(2026, 0, 1);

function eventAt(sequence: number, blocked: boolean): GuardEvent {
  return specToGuardEvent(
    {
      kind: "auth_checked",
      decision: blocked
        ? { result: "blocked", reason: "per_tx_cap_exceeded" }
        : { result: "allowed" },
      ledger: 8_000_000 + sequence,
      ledgerClosedAt: new Date(BASE_TIME + sequence * 1_000).toISOString(),
      transactionHash: fixtureTxHash(sequence),
      data: {},
    },
    TEST_CONTRACT,
  );
}

/** `count` events with the first `blockedCount` of them refused. */
function bufferOf(count: number, blockedCount: number): GuardEvent[] {
  const events: GuardEvent[] = [];
  for (let index = 0; index < count; index += 1) events.push(eventAt(index, index < blockedCount));
  return events;
}

interface Mounted {
  container: HTMLElement;
  assertive: HTMLElement;
  badge: () => HTMLElement | null;
  setEvents: (events: readonly GuardEvent[]) => Promise<void>;
  unmount: () => Promise<void>;
}

async function mountBadge(initial: readonly GuardEvent[]): Promise<Mounted> {
  clearAnnouncements();
  const container = document.createElement("div");
  document.body.appendChild(container);
  let events: readonly GuardEvent[] = initial;
  let root: ReturnType<typeof createRoot> | undefined;
  const render = async (next: readonly GuardEvent[]): Promise<void> => {
    events = next;
    await act(async () => {
      root?.render(
        // A fragment, not a wrapper around the announcer: `AriaAnnouncer` renders
        // its own two regions and takes no children, exactly as the layout
        // mounts it beside the panels rather than inside them.
        react.createElement(
          react.Fragment,
          null,
          react.createElement(AriaAnnouncer, { key: "announcer" }),
          react.createElement(BlockedEventBadge, { key: "badge", events }),
        ),
      );
    });
  };
  await act(async () => {
    root = createRoot(container);
  });
  await render(events);
  const assertive = container.querySelector<HTMLElement>('[aria-live="assertive"]');
  assert.ok(assertive, "the shell's assertive region must be rendered");
  return {
    container,
    assertive,
    badge: () => container.querySelector<HTMLElement>('[data-testid="blocked-count"]'),
    setEvents: render,
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await act(async () => {
      await sleep(100);
    });
  }
}

test("a 5,000-row buffer with 10 refusals shows and speaks exactly ten", async () => {
  const events = bufferOf(5_000, 10);
  const mounted = await mountBadge(events);
  try {
    await waitFor(() => mounted.badge() !== null, "the badge to appear");
    assert.equal(
      mounted.badge()?.textContent,
      "10 new blocked events",
      "the count is exact, and it does not depend on how many rows the DOM holds",
    );
    // The window closes on its own: no poll, no render, no operator action.
    await waitFor(
      () => mounted.assertive.textContent === "10 new blocked events",
      "the batch to be spoken",
    );
    assert.equal(
      mounted.badge(),
      null,
      "the badge clears when the count has been spoken, so the two cannot disagree",
    );
  } finally {
    await mounted.unmount();
  }
});

test("a buffer with no refusals renders no badge at all", async () => {
  const mounted = await mountBadge(bufferOf(500, 0));
  try {
    await act(async () => {
      await sleep(100);
    });
    assert.equal(mounted.badge(), null, "no refusals, nothing to say and nothing to show");
    assert.equal(mounted.assertive.textContent, "");
  } finally {
    await mounted.unmount();
  }
});

test("arrivals during the window are added to the batch, not announced separately", async () => {
  const mounted = await mountBadge(bufferOf(3, 1));
  try {
    await waitFor(() => mounted.badge()?.textContent === "1 new blocked event", "the first count");
    // Two more refusals land inside the same window.
    await mounted.setEvents(bufferOf(5, 3));
    assert.equal(
      mounted.badge()?.textContent,
      "3 new blocked events",
      "the badge counts the whole batch, not the latest poll",
    );
    await waitFor(
      () => mounted.assertive.textContent === "3 new blocked events",
      "the completed batch to be spoken",
    );
  } finally {
    await mounted.unmount();
  }
});

test("re-rendering the same buffer does not re-count or re-announce", async () => {
  const events = bufferOf(4, 2);
  const mounted = await mountBadge(events);
  try {
    await waitFor(
      () => mounted.assertive.textContent === "2 new blocked events",
      "the first batch to be spoken",
    );
    // A filter change, a paused queue, a parent re-render: the same array.
    for (let pass = 0; pass < 3; pass += 1) {
      await mounted.setEvents(events);
    }
    await act(async () => {
      await sleep(300);
    });
    assert.equal(mounted.badge(), null, "the count was already spoken and is not counted again");
    assert.equal(mounted.assertive.textContent, "2 new blocked events");
  } finally {
    await mounted.unmount();
  }
});
