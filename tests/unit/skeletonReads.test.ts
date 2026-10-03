/**
 * Skeleton / progressive loading for status reads (#31).
 *
 * Covers the acceptance criteria at two levels:
 *
 *   - `lib/guard/statusReadState.ts` — the pure three-phase decision
 *     (pending / failed / resolved) and the balance text contract, which is
 *     the surface the issue calls the zero-flash "heart-attack" surface.
 *   - `components/bits.tsx`'s `<Read>` and the CSS primitive — rendered
 *     through the jsdom harness for the DOM-level tests (aria-busy lifecycle
 *     with a deferred promise, anti-flash, no-flicker refresh, class parity).
 *
 * README grounding (the sentence is quoted in the PR): "Every policy field,
 * balance, and status indicator is read live from Soroban RPC with discrete
 * per-read error reporting. A failed RPC call renders an explicit error —
 * never a silent zero that looks like an empty policy." That is why the
 * failure branch keeps the explicit error block and why the pending branch
 * may never emit a bare "0".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, before, test } from "node:test";
import type { ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { Read } from "../../components/bits.tsx";
import {
  INITIAL_GRID_LABELS,
  balanceText,
  readPhase,
  skeletonSpecFor,
} from "../../lib/guard/statusReadState.ts";

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

beforeEach(() => {
  document.body.innerHTML = "";
});

// ── Pure three-phase decision ───────────────────────────────────────────────

test("readPhase maps null/undefined → pending, ok → resolved, !ok → failed", () => {
  assert.equal(readPhase(null), "pending");
  assert.equal(readPhase(undefined), "pending");
  assert.deepEqual(readPhase({ ok: true, value: 1n }), "resolved");
  assert.deepEqual(readPhase({ ok: false, error: "rpc unreachable" }), "failed");
});

test("balanceText: pending placeholder names the read and is never a number", () => {
  const pending = balanceText(null);
  assert.match(pending, /Reading balance…/);
  assert.doesNotMatch(pending, /^[\d.,]+/);
  assert.notEqual(pending.trim(), "0");
});

test("balanceText: failure is explicit and labelled, never a silent zero", () => {
  const failed = balanceText({ ok: false, error: "RPC unreachable" });
  assert.match(failed, /Balance unavailable — RPC unreachable/);
  assert.notEqual(failed.trim(), "0");
});

test("balanceText: resolved renders the formatted amount (zero is a real value, not a flash)", () => {
  assert.equal(balanceText({ ok: true, value: 0n }), "0.0000000 XLM");
  assert.equal(balanceText({ ok: true, value: 100_000_000_000n }), "10,000.0000000 XLM");
});

// ── Skeleton spec parity (what the first-paint grid reserves) ───────────────

test("skeleton spec covers every stat label in the first-paint grid", () => {
  for (const label of INITIAL_GRID_LABELS) {
    const spec = skeletonSpecFor(label);
    assert.ok(spec.lines >= 1, `${label} must reserve at least one skeleton line`);
  }
});

test("skeleton spec matches each stat's actual note-slot layout", () => {
  assert.equal(skeletonSpecFor("Admin freeze").lines, 1);
  assert.equal(skeletonSpecFor("Dead-man switch").lines, 2);
  assert.equal(skeletonSpecFor("Policy installed").lines, 2);
  assert.equal(skeletonSpecFor("Last heartbeat").lines, 2);
  assert.equal(skeletonSpecFor("Policy in force").lines, 2);
});

// ── DOM harness ─────────────────────────────────────────────────────────────

interface Rendered {
  host: HTMLElement;
  /** Re-render the same root with a new element (the state-change simulation). */
  rerender: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

async function renderElement(element: ReactElement): Promise<Rendered> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
  return {
    host,
    rerender: async (next: ReactElement) => {
      await act(async () => {
        root?.render(next);
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      host.remove();
    },
  };
}

/** The balance surface's Read element for a given read result (or pending). */
function balanceRead(
  result: { ok: true; value: bigint } | { ok: false; error: string } | null,
): ReactElement {
  return react.createElement(Read, {
    result,
    label: "balance()",
    render: (value: unknown) => String(value),
  });
}

// ── Render triple (balance is the zero-flash heart-attack surface) ──────────

test("render triple on the balance surface: pending → skeleton, failed → error, resolved → value", async () => {
  // pending: skeleton present, no value, no error block
  const pending = await renderElement(balanceRead(null));
  try {
    assert.ok(pending.host.querySelector(".skeleton"), "pending must render a skeleton");
    assert.equal(
      pending.host.querySelector(".error"),
      null,
      "pending must not render an error block",
    );
    assert.doesNotMatch(pending.host.textContent ?? "", /0/);
  } finally {
    await pending.unmount();
  }

  // failed: error class + message, value absent (README no-mock-state choice)
  const failed = await renderElement(balanceRead({ ok: false, error: "RPC unreachable" }));
  try {
    const errorBlock = failed.host.querySelector(".error");
    assert.ok(errorBlock, "failure must render the error block");
    assert.match(errorBlock?.textContent ?? "", /balance\(\): read failed/);
    assert.match(errorBlock?.textContent ?? "", /RPC unreachable/);
    assert.ok(!failed.host.querySelector(".skeleton"), "failure must not render a skeleton");
    assert.ok(!resolvedLooksLikeZero(failed.host.textContent ?? ""));
  } finally {
    await failed.unmount();
  }

  // resolved: value present, skeleton gone. 0n is a REAL ledger value here —
  // only the pending phase is forbidden from looking like a number.
  const resolved = await renderElement(balanceRead({ ok: true, value: 0n }));
  try {
    assert.equal(resolved.host.textContent, "0");
    assert.ok(!resolved.host.querySelector(".skeleton"), "resolved must not render a skeleton");
    assert.equal(
      resolved.host.querySelector(".error"),
      null,
      "resolved must not render an error block",
    );
  } finally {
    await resolved.unmount();
  }
});

function resolvedLooksLikeZero(text: string): boolean {
  return /(^|\s)0(\.\d*)?(\s|$)/.test(text.trim());
}

// ── Anti-flash (THE test) ───────────────────────────────────────────────────

test("anti-flash: pending balance container textContent matches placeholder-or-empty, fails on bare 0", async () => {
  const rendered = await renderElement(balanceRead(null));
  try {
    const text = rendered.host.textContent ?? "";
    // THE anti-flash assertion: pending text is placeholder-or-empty; a bare
    // "0" as a value would fail this match.
    const placeholderOrEmpty = /^(|\s*Reading[^0]*…\s*)$/;
    assert.match(
      text,
      placeholderOrEmpty,
      `pending balance must render placeholder-or-empty, got ${JSON.stringify(text)}`,
    );
    assert.ok(!resolvedLooksLikeZero(text), "pending text must not contain a zero value");
  } finally {
    await rendered.unmount();
  }
});

// ── No-flicker refresh (keep-previous-while-in-flight contract) ─────────────

test("no-flicker refresh: the previous value persists while the re-read is in flight, then swaps to the new value", async () => {
  // The provider keeps the previous snapshot while refresh() awaits the chain
  // (it calls setSnapshot only after the read settles), so the component sees:
  // resolved value → same resolved value during the re-read → new value.
  // This test replays that exact prop sequence through a real React root.
  const previous: { ok: true; value: bigint } = { ok: true, value: 5_000_000_000n };
  const next: { ok: true; value: bigint } = { ok: true, value: 7_000_000_000n };

  const rendered = await renderElement(balanceRead(previous));
  try {
    assert.equal(rendered.host.textContent, "5000000000");

    // Re-read in flight: the snapshot prop is unchanged (keep-previous) — the
    // component re-renders (refreshing flips elsewhere) and Read must show the
    // stale value, never a skeleton and never a blank.
    await rendered.rerender(balanceRead(previous));
    assert.equal(
      rendered.host.textContent,
      "5000000000",
      "an in-flight refresh must not blank or skeleton the previous value",
    );
    assert.ok(
      !rendered.host.querySelector(".skeleton"),
      "no skeleton while a valid previous value is held",
    );

    // The re-read settles: the value swaps in place, still no skeleton frame.
    await rendered.rerender(balanceRead(next));
    assert.equal(rendered.host.textContent, "7000000000");
    assert.ok(!rendered.host.querySelector(".skeleton"));
  } finally {
    await rendered.unmount();
  }
});

test("no-flicker refresh, failure branch: a failed re-read unmounts the old value to an explicit error block", async () => {
  // Grounded in the README's no-mock-state sentence: the provider drops the
  // snapshot and reports snapshotError on transport failure, so the operator
  // sees an explicit error — never the old value masquerading as live state
  // and never a zero. (Chosen over stale-on-failure; the README quote in the
  // PR is the deciding sentence.)
  const previous: { ok: true; value: bigint } = { ok: true, value: 5_000_000_000n };
  const rendered = await renderElement(balanceRead(previous));
  try {
    assert.equal(rendered.host.textContent, "5000000000");
    await rendered.rerender(balanceRead({ ok: false, error: "ledger timeout" }));
    const errorBlock = rendered.host.querySelector(".error");
    assert.ok(errorBlock, "a failed re-read must replace the old value with an error block");
    assert.match(errorBlock?.textContent ?? "", /ledger timeout/);
    assert.ok(!rendered.host.querySelector(".skeleton"));
    assert.notEqual(
      rendered.host.textContent,
      "5000000000",
      "the stale value must not survive a failure",
    );
  } finally {
    await rendered.unmount();
  }
});

// ── aria-busy lifecycle (deferred-promise controlled) ───────────────────────

test("aria-busy lifecycle: true while the deferred read is in flight, false once it resolves", async () => {
  // A minimal read-owning component wired the way GuardProvider is: a pending
  // read until the promise settles, then the snapshot. The deferred promise
  // gives the test exact control of the resolve moment.
  const deferred = makeDeferred<bigint>();
  function Panel(): ReactElement {
    const { useState, useEffect } = react;
    const [result, setResult] = useState<{ ok: true; value: bigint } | null>(null);
    useEffect(() => {
      let alive = true;
      void deferred.promise.then((value: bigint) => {
        if (alive) setResult({ ok: true, value });
      });
      return () => {
        alive = false;
      };
    }, []);
    return react.createElement(
      "div",
      { "aria-busy": result === null ? "true" : "false", "data-testid": "panel" },
      react.createElement(Read, {
        result,
        label: "balance()",
        render: (value: unknown) => String(value),
      }),
    );
  }

  const rendered = await renderElement(react.createElement(Panel));
  try {
    const panel = rendered.host.querySelector('[data-testid="panel"]');
    assert.equal(
      panel?.getAttribute("aria-busy"),
      "true",
      "in-flight read must set aria-busy=true",
    );
    assert.ok(rendered.host.querySelector(".skeleton"), "pending phase shows the skeleton");
    assert.equal(rendered.host.textContent, "", "pending phase shows no value");

    await act(async () => {
      deferred.resolve(250_000_000n);
      await sleep(0);
    });

    assert.equal(
      panel?.getAttribute("aria-busy"),
      "false",
      "resolved read must set aria-busy=false",
    );
    assert.ok(!rendered.host.querySelector(".skeleton"), "resolved phase clears the skeleton");
    assert.equal(rendered.host.textContent, "250000000");
  } finally {
    await rendered.unmount();
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ── Class parity / shift prevention ─────────────────────────────────────────

test("class parity: the skeleton primitive shares the value slot's sizing contract", () => {
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(css, /\.skeleton \{/, "the .skeleton primitive must exist");
  assert.match(
    css,
    /\.skeleton \{[^}]*height: 1em;/,
    "the skeleton must size in em so it inherits the slot's font metrics",
  );
  assert.match(
    css,
    /\.stat \.v \{[^}]*font-size: 19px;/,
    "the value slot (.stat .v) is the skeleton's size counterpart",
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[^@]*?\.skeleton \{\s*animation: none;\s*\}/,
    "reduced motion must stop the shimmer without removing the reservation",
  );
});

// ── Adopted on the pending surfaces (grep-verified) ─────────────────────────

test("skeleton adoption is present on the pending surfaces (grep-verified)", () => {
  const bits = readFileSync("components/bits.tsx", "utf8");
  const status = readFileSync("components/StatusPanel.tsx", "utf8");
  const telemetry = readFileSync("components/TelemetryFeed.tsx", "utf8");
  const fleet = readFileSync("components/FleetTable.tsx", "utf8");

  assert.match(bits, /SKELETON_CLASS/, "Read's pending branch must use the skeleton primitive");
  assert.match(
    status,
    /INITIAL_GRID_LABELS\.map/,
    "the first-paint grid must render skeleton stats",
  );
  assert.match(
    status,
    /aria-busy=\{initialLoadPending\}/,
    "the panel must carry the aria-busy lifecycle",
  );
  assert.match(
    telemetry,
    /aria-busy="true"/,
    "the telemetry feed's initial load must be aria-busy",
  );
  assert.match(fleet, /aria-busy="true"/, "the fleet table's initial poll must be aria-busy");
  assert.doesNotMatch(fleet, /Loading fleet data\.\.\./, "the plain loading text must be gone");
});
