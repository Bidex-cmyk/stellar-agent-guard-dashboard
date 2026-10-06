import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { SetupWizard } from "../../components/SetupWizard.tsx";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import { GuardContext } from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import { SETUP_STORAGE_KEY } from "../../lib/guard/setupChecklist.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";

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

const GUARD = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

/** A server whose every method rejects, so reads settle into their error states. */
const noNetworkServer = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error("network disabled in unit tests")),
  },
);

/**
 * A mounted snapshot for a freshly deployed guard with no policy — the exact
 * state the checklist exists to surface: default-deny.
 */
function policyMissingSnapshot(): GuardSnapshot {
  return {
    guard: GUARD,
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        has_policy: false,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 0n,
        now: 1n,
      },
    },
    policy: { ok: true, value: null },
    window: { ok: true, value: { total: 0n, entries: [] } },
    identity: {
      ok: true,
      value: {
        reportedWasmHash: PHASE1_ARTIFACT.wasmHash,
        fetchedSha256: PHASE1_ARTIFACT.wasmHash,
        bytes: PHASE1_ARTIFACT.wasmBytes,
        match: true,
      },
    },
  };
}

function contextValue(snapshot: GuardSnapshot) {
  return {
    server: noNetworkServer,
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => {
      throw new Error("no signing in setup-wizard tests");
    },
    instances: [{ guard: GUARD, label: "Test guard", provenance: "test" }],
    guard: GUARD,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    events: [],
    feed: {
      watching: false,
      latestLedger: null,
      error: null,
      lastPolledAt: null,
      guards: [],
      capped: 0,
      cappedLabels: [],
    },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
  } as any;
}

interface Rendered {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function render(element: ReactElement, snapshot: GuardSnapshot): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(GuardContext.Provider, { value: contextValue(snapshot) }, element),
    );
  });
  // Let mount effects (the initialize read) settle inside act.
  await act(async () => {
    await sleep(80);
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

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `expected a button labelled "${text}"`);
  return button;
}

async function click(container: HTMLElement, text: string): Promise<void> {
  const button = buttonByText(container, text);
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await sleep(40);
  });
}

function step(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`li[data-step="${id}"]`);
}

test("the checklist is a semantic ordered list with text status on every step", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    const list = rendered.container.querySelector<HTMLOListElement>(
      "ol[data-testid='setup-steps']",
    );
    assert.ok(list, "the steps must be rendered as an ordered list");
    const items = list.querySelectorAll("li");
    assert.equal(items.length, 4, "four steps: deployed, initialized, policy, verified");

    // Status is conveyed as text (and an icon), not by colour alone.
    for (const item of Array.from(items)) {
      assert.match(
        item.textContent ?? "",
        /Done|Pending|Error/,
        "each step must carry a text status label",
      );
    }
    assert.equal(step(rendered.container, "deployed")?.dataset.state, "pending");
    assert.equal(step(rendered.container, "policy")?.dataset.state, "pending");
    assert.equal(step(rendered.container, "verified")?.dataset.state, "pending");
  } finally {
    await rendered.unmount();
  }
});

test("a dismissed wizard still leaves the default-deny warning visible (safety invariant)", async () => {
  window.localStorage.setItem(
    SETUP_STORAGE_KEY,
    JSON.stringify({ [GUARD]: { dismissed: true, deployedMarker: null } }),
  );
  const rendered = await render(
    react.createElement(
      react.Fragment,
      null,
      react.createElement(StatusPanel),
      react.createElement(SetupWizard),
    ),
    policyMissingSnapshot(),
  );
  try {
    // The wizard is hidden...
    assert.equal(
      rendered.container.querySelector("ol[data-testid='setup-steps']"),
      null,
      "the checklist steps must be hidden once dismissed",
    );
    // ...but the chain-derived warning is not concealed by that dismissal.
    // Matched loosely on the middle clause so this asserts the *banner* — the
    // safety invariant — rather than one wording of it, which `StatusPanel` owns.
    assert.match(
      rendered.container.textContent ?? "",
      /No policy installed .* in default-deny/,
      "StatusPanel must still warn about default-deny while the wizard is dismissed",
    );
    assert.ok(
      buttonByText(rendered.container, "Show setup checklist"),
      "a reopen affordance must exist",
    );
  } finally {
    await rendered.unmount();
    window.localStorage.removeItem(SETUP_STORAGE_KEY);
  }
});

test("reopening the wizard restores it with the derived steps", async () => {
  window.localStorage.setItem(
    SETUP_STORAGE_KEY,
    JSON.stringify({ [GUARD]: { dismissed: true, deployedMarker: null } }),
  );
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    assert.equal(rendered.container.querySelector("ol[data-testid='setup-steps']"), null);
    await click(rendered.container, "Show setup checklist");
    const list = rendered.container.querySelector("ol[data-testid='setup-steps']");
    assert.ok(list, "the checklist must come back after reopening");
    assert.equal(list.querySelectorAll("li").length, 4);
    assert.equal(step(rendered.container, "policy")?.dataset.state, "pending");
  } finally {
    await rendered.unmount();
    window.localStorage.removeItem(SETUP_STORAGE_KEY);
  }
});

test("a failed verification re-read leaves step 4 in error, never optimistically green", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    assert.equal(step(rendered.container, "verified")?.dataset.state, "pending");
    await click(rendered.container, "Re-verify status & policy");

    const verified = step(rendered.container, "verified");
    assert.equal(verified?.dataset.state, "error", "a failed re-read must not turn the step green");
    assert.match(verified?.textContent ?? "", /Error/);
    assert.match(rendered.container.textContent ?? "", /verification read failed/i);

    // The verification result is held in the component and derived from the
    // fetch; no local write records it.
    const raw = window.localStorage.getItem(SETUP_STORAGE_KEY);
    if (raw) {
      const entry = (JSON.parse(raw) as Record<string, Record<string, unknown>>)[GUARD] ?? {};
      assert.deepEqual([...Object.keys(entry)].sort(), ["deployedMarker", "dismissed"]);
    }
  } finally {
    await rendered.unmount();
  }
});
