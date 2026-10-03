/**
 * PanicPanel's freeze-challenge confirmation (issue #15).
 *
 * Component-level coverage for the escalation rule: below the threshold the
 * dialog is the existing two-step (a regression this suite pins by asserting
 * the challenge block is *absent*), at/above it the confirm step upgrades to
 * typing the guard address's last 6 characters, and any balance the panel
 * could not read fails safe to the challenge.
 *
 * The freeze write itself is untouched by this issue: the "match → freeze
 * proceeds" test asserts the call-count on the very first network call of the
 * unchanged path (`server.getAccount` inside `runInvocation`,
 * `lib/guard/submit.ts` → `freezeGuard`, `lib/guard/guardOps.ts`), so a
 * refactor that starts gating the RPC behind something else fails here.
 *
 * A11y: label/error pairing is asserted directly below; axe-core coverage of
 * the *open challenge dialog* comes from
 * `tests/unit/a11yAudit.test.ts` ("the freeze confirmation dialog passes
 * axe-core while open") — its fixture server fails every read, so that scan
 * already renders this challenge block (pending the full a11y checklist audit).
 * Browser-level e2e — real Tab traversal, real keystrokes — is owned by the
 * Playwright suite (`tests/e2e/guardLifecycle.spec.ts`), cross-cited here per
 * the issue: these are component interactions, not e2e.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { PanicPanel } from "../../components/PanicPanel.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { FREEZE_CHALLENGE_THRESHOLD_STROOPS } from "../../lib/guard/freezeChallenge.ts";
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

/** The pinned Phase 1 guard address — a real 56-char contract `C…` strkey. */
const GUARD = PHASE1_ARTIFACT.guard;
const SUFFIX = GUARD.slice(-6);
/** A realistic wrong answer: the address's FIRST 6 chars (prefix, not suffix). */
const WRONG = GUARD.slice(0, 6);
const ADMIN = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const XLM = 10_000_000n;

interface ServerCalls {
  /** Balance reads (threshold input) — the read under test, not the freeze. */
  getAssetBalance: number;
  /** The freeze write's first network call: `runInvocation` loads the signer. */
  getAccount: number;
  simulateTransaction: number;
  sendTransaction: number;
}

/**
 * A server stand-in that answers balance reads from a fixed number and
 * refuses everything else, counting each call. `balanceStroops: null` makes
 * the balance read throw — the RPC-error case the fail-safe rule covers.
 */
function fakeServer(balanceStroops: bigint | null): {
  server: unknown;
  calls: ServerCalls;
} {
  const calls: ServerCalls = {
    getAssetBalance: 0,
    getAccount: 0,
    simulateTransaction: 0,
    sendTransaction: 0,
  };
  const server = {
    async getAssetBalance(): Promise<unknown> {
      calls.getAssetBalance += 1;
      if (balanceStroops === null) throw new Error("RPC unreachable");
      return {
        latestLedger: 1_000,
        balanceEntry: {
          amount: balanceStroops.toString(),
          authorized: true,
          clawback: false,
        },
      };
    },
    async getAccount(): Promise<never> {
      calls.getAccount += 1;
      throw new Error("network disabled in this test");
    },
    async simulateTransaction(): Promise<never> {
      calls.simulateTransaction += 1;
      throw new Error("network disabled in this test");
    },
    async sendTransaction(): Promise<never> {
      calls.sendTransaction += 1;
      throw new Error("a unit test must never reach broadcast");
    },
  };
  return { server, calls };
}

/** A guard context with a connected wallet and no network beyond `server`. */
function guardValue(server: unknown): unknown {
  return {
    server,
    wallet: {
      address: ADMIN,
      networkPassphrase: "Test SDF Network ; September 2015",
      network: "Testnet",
    },
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => ({
      address: ADMIN,
      async signTransaction(): Promise<string> {
        throw new Error("no signature needed before the freeze path's discovery read");
      },
      async signAuthEntry(): Promise<string> {
        throw new Error("no signature needed before the freeze path's discovery read");
      },
    }),
    instances: [],
    guard: GUARD,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot: null,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    feed: { watching: false, latestLedger: null, error: null, lastPolledAt: null },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
  };
}

interface Rendered {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function renderPanel(element: ReactElement): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  // Let the mount-effect balance read settle inside act.
  await act(async () => {
    await sleep(60);
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

function renderGuarded(panel: ReactElement, value: any): ReactElement {
  return react.createElement(
    GuardEventsContext.Provider,
    { value: [] },
    react.createElement(GuardContext.Provider, { value }, panel),
  );
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `expected a button labelled "${text}"`);
  return button;
}

function challengeBlock(container: HTMLElement): HTMLElement {
  const block = container.querySelector<HTMLElement>('[data-testid="freeze-challenge-block"]');
  assert.ok(block, "the typed challenge block must render");
  return block;
}

function challengeInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#freeze-challenge");
  assert.ok(input, "the challenge input must render");
  return input;
}

/** Open the freeze confirm dialog and let its balance re-read settle. */
async function openDialog(container: HTMLElement): Promise<void> {
  const trigger = buttonByText(container, "Freeze this account");
  await act(async () => {
    trigger.click();
    await sleep(20);
  });
  assert.ok(container.querySelector('[role="dialog"]'), "the confirm dialog must open");
}

/** Type into a controlled input the way testing-library does: setter + input. */
async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(0);
  });
}

async function acknowledge(container: HTMLElement): Promise<void> {
  const ack = container.querySelector<HTMLInputElement>("#ack-freeze");
  assert.ok(ack, "the acknowledgement checkbox must render");
  await act(async () => {
    ack.click();
    await sleep(0);
  });
}

async function runScenario(balanceStroops: bigint | null): Promise<{
  rendered: Rendered;
  calls: ServerCalls;
}> {
  const { server, calls } = fakeServer(balanceStroops);
  const rendered = await renderPanel(
    renderGuarded(react.createElement(PanicPanel), guardValue(server)),
  );
  return { rendered, calls };
}

test("below the threshold the confirm step is the existing two-step, unchanged", async () => {
  // One stroop below the boundary: the closest possible "small" account.
  const { rendered, calls } = await runScenario(FREEZE_CHALLENGE_THRESHOLD_STROOPS - 1n);
  try {
    await openDialog(rendered.container);

    assert.equal(
      rendered.container.querySelector('[data-testid="freeze-challenge-block"]'),
      null,
      "no challenge block below the threshold — no friction where stakes are small",
    );
    assert.equal(rendered.container.querySelector("#freeze-challenge"), null);

    const sign = buttonByText(rendered.container, "Sign freeze");
    assert.equal(
      sign.disabled,
      true,
      "the acknowledgement checkbox still gates the standard confirm",
    );
    await acknowledge(rendered.container);
    assert.equal(
      buttonByText(rendered.container, "Sign freeze").disabled,
      false,
      "acknowledgement alone unlocks the standard two-step",
    );
    assert.equal(calls.getAccount, 0, "nothing is frozen until the operator signs");
  } finally {
    await rendered.unmount();
  }
});

test("a balance exactly AT the threshold requires the typed challenge (boundary inclusive)", async () => {
  const { rendered, calls } = await runScenario(FREEZE_CHALLENGE_THRESHOLD_STROOPS);
  try {
    await openDialog(rendered.container);

    const block = challengeBlock(rendered.container);
    assert.ok(
      block.textContent?.includes(GUARD),
      "the challenge shows the full target address to type against",
    );
    const why = rendered.container.querySelector("#freeze-challenge-why");
    assert.ok(why, "the WHY copy is a described-by node");
    assert.match(why.textContent ?? "", /10,000 XLM large-exposure threshold/);
    assert.match(
      why.textContent ?? "",
      /prevents an accidental freeze/,
      "the copy states WHY in one line",
    );
    assert.match(
      why.textContent ?? "",
      /not protection against anyone who can already see this page/,
      "the copy is threat-honest: it must not imply it stops someone with the page open",
    );

    await acknowledge(rendered.container);
    const sign = buttonByText(rendered.container, "Sign freeze");
    assert.equal(
      sign.disabled,
      true,
      "the boundary balance demands the typed answer, checkbox alone is not enough",
    );
    assert.equal(
      rendered.container.querySelector("#freeze-challenge-error"),
      null,
      "no premature error before the operator has typed anything",
    );
    assert.equal(calls.getAccount, 0);
  } finally {
    await rendered.unmount();
  }
});

test("a mismatched suffix keeps confirm disabled with an inline error, and the freeze RPC is never called", async () => {
  const { rendered, calls } = await runScenario(250_000n * XLM);
  try {
    await openDialog(rendered.container);
    await acknowledge(rendered.container);
    const input = challengeInput(rendered.container);
    await typeInto(input, WRONG);

    const error = rendered.container.querySelector<HTMLElement>("#freeze-challenge-error");
    assert.ok(error, "a mismatch shows an inline error");
    assert.equal(error.getAttribute("role"), "alert", "the error announces itself");
    assert.equal(
      rendered.container
        .querySelector<HTMLInputElement>("#freeze-challenge")
        ?.getAttribute("aria-invalid"),
      "true",
    );
    assert.ok(
      (input.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .includes("freeze-challenge-error"),
      "the error id joins the input's description",
    );

    const sign = buttonByText(rendered.container, "Sign freeze");
    const exportXdr = buttonByText(rendered.container, "Export XDR");
    assert.equal(sign.disabled, true, "mismatch → confirm disabled");
    assert.equal(exportXdr.disabled, true, "the export escape hatch is gated by the same ritual");

    // Attempt the action anyway: a disabled control must not run it.
    await act(async () => {
      sign.click();
      exportXdr.click();
      await sleep(20);
    });
    assert.equal(calls.getAccount, 0, "freeze RPC not called — call-count 0");
    assert.equal(calls.simulateTransaction, 0, "not even a freeze-path simulation ran");
    assert.equal(calls.sendTransaction, 0, "nothing was broadcast");
  } finally {
    await rendered.unmount();
  }
});

test("the exact suffix enables confirm and the existing freeze path proceeds unchanged", async () => {
  const { rendered, calls } = await runScenario(250_000n * XLM);
  try {
    await openDialog(rendered.container);
    await acknowledge(rendered.container);
    const input = challengeInput(rendered.container);
    await typeInto(input, SUFFIX);

    assert.equal(
      rendered.container.querySelector("#freeze-challenge-error"),
      null,
      "the correct suffix clears the error state",
    );
    const sign = buttonByText(rendered.container, "Sign freeze");
    assert.equal(sign.disabled, false, "acknowledged + matched → confirm enabled");

    await act(async () => {
      buttonByText(rendered.container, "Sign freeze").click();
      await sleep(60);
    });
    assert.equal(
      calls.getAccount,
      1,
      "the freeze write entered its path — runInvocation's first read (lib/guard/submit.ts), unchanged by this issue",
    );
    assert.equal(
      calls.sendTransaction,
      0,
      "the fake server refuses discovery, so nothing is broadcast",
    );
  } finally {
    await rendered.unmount();
  }
});

test("when the live balance read fails the challenge stays on (fail-safe on the risky side)", async () => {
  const { rendered, calls } = await runScenario(null);
  try {
    await openDialog(rendered.container);

    const block = challengeBlock(rendered.container);
    const why = block.querySelector("#freeze-challenge-why");
    assert.match(why?.textContent ?? "", /balance could not be read/);
    assert.match(
      why?.textContent ?? "",
      /friction goes up, never down/,
      "the fallback is justified in the copy: uncertainty escalates, never reduces",
    );
    await acknowledge(rendered.container);
    assert.equal(
      buttonByText(rendered.container, "Sign freeze").disabled,
      true,
      "unknown balance still demands the typed answer",
    );
    assert.equal(calls.getAccount, 0);
  } finally {
    await rendered.unmount();
  }
});

test("the challenge input has a label, an error association, and sits in the dialog's keyboard order", async () => {
  const { rendered } = await runScenario(FREEZE_CHALLENGE_THRESHOLD_STROOPS + 1n);
  try {
    await openDialog(rendered.container);

    const input = challengeInput(rendered.container);
    const label = rendered.container.querySelector<HTMLLabelElement>(
      'label[for="freeze-challenge"]',
    );
    assert.ok(label, "the input has a real, programmatically associated label");
    assert.ok((label.textContent ?? "").trim().length > 0, "the label names the input");
    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(/\s+/);
    assert.ok(describedBy.includes("freeze-challenge-why"), "the WHY copy describes the input");
    assert.ok(rendered.container.querySelector("#freeze-challenge-why"));

    await acknowledge(rendered.container);
    await typeInto(input, WRONG);
    assert.ok(
      (input.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .includes("freeze-challenge-error"),
      "once shown, the error joins the description",
    );
    assert.ok(rendered.container.querySelector('#freeze-challenge-error[role="alert"]'));

    // Keyboard order, asserted in the challenge-satisfied state so every
    // control is enabled: the input is a focusable inside the dialog's own
    // trap query, sitting between the checkbox and the buttons, so Tab walks
    // into it. (jsdom implements no default Tab movement — real traversal is
    // the Playwright suite's job, tests/e2e/guardLifecycle.spec.ts.)
    await typeInto(input, SUFFIX);
    const sign = buttonByText(rendered.container, "Sign freeze");
    assert.equal(sign.disabled, false, "the satisfied challenge enables the confirm");
    const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    const ack = rendered.container.querySelector<HTMLElement>("#ack-freeze");
    assert.ok(ack);
    assert.ok(
      focusables.indexOf(ack) < focusables.indexOf(input) &&
        focusables.indexOf(input) < focusables.indexOf(sign),
      "focus order is checkbox → challenge input → sign",
    );
  } finally {
    await rendered.unmount();
  }
});

test("the challenge flow completes with keyboard interactions only — no pointer events", async () => {
  const { rendered, calls } = await runScenario(250_000n * XLM);
  let pointerEvents = 0;
  const onPointer = (): void => {
    pointerEvents += 1;
  };
  const POINTER = ["pointerdown", "pointerup", "mousedown", "mouseup"];
  for (const type of POINTER) document.addEventListener(type, onPointer);
  try {
    // 1. Reach the trigger by focus alone (as Tab would).
    const trigger = buttonByText(rendered.container, "Freeze this account");
    trigger.focus();
    assert.equal(document.activeElement, trigger, "the trigger is focusable without a pointer");

    // 2. Activate it from the keyboard: Enter on a button produces a click
    //    event in real browsers; jsdom implements no default activation, so
    //    the click — the keyboard's own output — is dispatched directly.
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      trigger.click();
      await sleep(20);
    });
    const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, "the dialog opens from a keyboard activation");
    assert.equal(document.activeElement, dialog, "focus moves into the dialog without a pointer");

    // 3. Acknowledge: Space/Enter on a checkbox also produces a click event.
    const ack = rendered.container.querySelector<HTMLInputElement>("#ack-freeze");
    assert.ok(ack);
    await act(async () => {
      ack.focus();
      ack.click();
      await sleep(0);
    });

    // 4. Type the challenge at the input focus lands on.
    const input = challengeInput(rendered.container);
    await act(async () => {
      input.focus();
    });
    assert.equal(document.activeElement, input, "the challenge input takes focus");
    await typeInto(input, SUFFIX);

    // 5. Activate Sign freeze from the keyboard.
    await act(async () => {
      const sign = buttonByText(rendered.container, "Sign freeze");
      assert.equal(sign.disabled, false, "acknowledged + matched enables the confirm");
      sign.focus();
      sign.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      sign.click();
      await sleep(60);
    });

    assert.equal(calls.getAccount, 1, "the freeze proceeded without any pointer input");
    assert.equal(
      pointerEvents,
      0,
      "no pointer or mouse-button event was dispatched anywhere in the flow",
    );
  } finally {
    for (const type of POINTER) document.removeEventListener(type, onPointer);
    await rendered.unmount();
  }
});
