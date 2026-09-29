/**
 * The telemetry chart in a real DOM: an axe-core scan with data present,
 * keyboard navigation with its live readout, the window toggle, and the table
 * fallback.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type axeCore from "axe-core";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { TelemetryChart } from "../../components/TelemetryChart.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;
let axe: typeof axeCore;

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

// Anchor fixtures to the start of the current 5-minute interval, so the
// recent events always share the chart's last bucket whatever the wall clock.
const BUCKET_START = Math.floor(Date.now() / 300_000) * 300_000;

function event(minutesAgo: number, result: "allowed" | "blocked"): GuardEvent {
  return {
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: result === "allowed" ? "ledger" : "diagnostic",
    contractId: GUARD,
    ledger: result === "allowed" ? 1000 + minutesAgo : null,
    ledgerClosedAt: new Date(BUCKET_START + 1_000 - minutesAgo * 60_000).toISOString(),
    transactionHash: null,
    decision: { result, reason: result === "blocked" ? "per_tx_cap_exceeded" : null, source: "ledger" },
    data: {},
  };
}

const bucketSecs = BigInt(BUCKET_START / 1000);

// Three in the current interval (offsets of seconds), one 40 minutes earlier.
const EVENTS: GuardEvent[] = [event(0, "allowed"), event(0.01, "allowed"), event(0.015, "blocked"), event(40, "allowed")];

// A partial context is enough for the chart.
const CONTEXT: any = {
  guard: GUARD,
  snapshot: {
    guard: GUARD,
    fetchedAt: new Date().toISOString(),
    window: {
      ok: true,
      value: {
        total: 12_345_678_901_234_567_890n,
        entries: [
          { ts: bucketSecs + 2n, amount: 12_345_678_901_234_567_000n },
          { ts: bucketSecs - 1_800n, amount: 890n },
        ],
      },
    },
  },
};

let container: HTMLElement;
let unmount: () => Promise<void>;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
  axe = ((await import("axe-core")) as unknown as { default: typeof axeCore }).default;

  container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value: CONTEXT },
        react.createElement(GuardEventsContext.Provider, { value: EVENTS }, react.createElement(TelemetryChart)),
      ),
    );
  });
  await act(async () => {
    await sleep(20);
  });
  unmount = async () => {
    await act(async () => root?.unmount());
    container.remove();
  };
});

after(() => unmount());

function svg(): SVGSVGElement {
  const found = container.querySelector<SVGSVGElement>('svg[role="img"]');
  assert.ok(found, "the chart is an SVG with role=img");
  return found;
}

async function key(name: string) {
  await act(async () => {
    svg().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

test("passes automated axe-core WCAG 2.1 AA checks with data present", async () => {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  assert.deepEqual(
    results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(" ")}`),
    [],
  );
});

test("the SVG's accessible name summarises the data, with exact stroop totals", () => {
  const label = svg().getAttribute("aria-label") ?? "";
  assert.match(label, /^Last hour in 12 5-minute intervals/);
  assert.match(label, /3 allowed and 1 blocked decisions/);
  assert.match(label, /12,345,678,901,234,567,890 stroops settled across 2 spends/);
  assert.equal(svg().getAttribute("tabindex"), "0");
});

test("arrow keys move through intervals and the readout is announced", async () => {
  const status = container.querySelector('[role="status"]');
  assert.ok(status);
  await key("End");
  assert.match(status.textContent ?? "", /2 allowed, 1 blocked, 12,345,678,901,234,567,000 stroops settled/);
  assert.ok(container.querySelector(".tchart-tip"), "the visual tooltip follows keyboard focus too");
  await key("Home");
  assert.match(status.textContent ?? "", /0 allowed, 0 blocked, 0 stroops/);
  await key("Escape");
  assert.equal(status.textContent, "");
  assert.equal(container.querySelector(".tchart-tip"), null);
});

test("hovering a column shows the tooltip with exact counts and stroops", async () => {
  const hits = container.querySelectorAll(".tchart-hit");
  assert.equal(hits.length, 12);
  await act(async () => {
    hits[hits.length - 1]!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  });
  const tip = container.querySelector(".tchart-tip");
  assert.ok(tip);
  assert.match(tip.textContent ?? "", /2 allowed/);
  assert.match(tip.textContent ?? "", /12,345,678,901,234,567,000 stroops/);
});

test("the window toggle switches between 1h, 6h and 24h", async () => {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
  assert.deepEqual(buttons.map((button) => button.textContent), ["1h", "6h", "24h"]);
  assert.equal(buttons[0]!.getAttribute("aria-pressed"), "true");
  await act(async () => buttons[2]!.click());
  assert.equal(buttons[2]!.getAttribute("aria-pressed"), "true");
  assert.match(svg().getAttribute("aria-label") ?? "", /^Last 24 hours in 24 1-hour intervals/);
  assert.equal(container.querySelectorAll(".tchart-hit").length, 24);
});

test("a data table carries every interval for screen readers and anyone who prefers it", () => {
  const table = container.querySelector("details table");
  assert.ok(table);
  assert.ok(table.querySelector("caption"));
  assert.equal(table.querySelectorAll("tbody tr").length, 24);
  assert.equal(table.querySelectorAll('th[scope="col"]').length, 6);
});
