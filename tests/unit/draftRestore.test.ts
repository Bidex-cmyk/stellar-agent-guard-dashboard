/**
 * Component-level restore behaviour for the two draft-owning panels (#20).
 *
 * The unit tests pin the storage helper; these pin the wiring: a draft that
 * exists in localStorage must appear in the form on mount, with a visible
 * banner and a working discard; no draft means a clean mount; an expired
 * draft means no banner and a purged key.
 *
 * The suite lives under `tests/unit/` because the npm test glob covers
 * `tests/unit/*.test.ts` and `tests/fuzz/*.test.ts` — the `tests/components/`
 * directory is not in the glob (precedent: `tests/unit/copyButton.test.ts`).
 */

import assert from "node:assert/strict";
import { before, afterEach, test } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { PolicyForm } from "../../components/PolicyForm.tsx";
import { DeployPanel } from "../../components/DeployPanel.tsx";
import {
  GuardContext,
  GuardEventsContext,
  type GuardContextValue,
} from "../../components/GuardProvider.tsx";
import { NETWORK } from "../../lib/guard/network.ts";
import { scopedStorageKey } from "../../lib/guard/guardScoped.ts";
import {
  DEPLOY_DRAFT_BASE,
  DEPLOY_DRAFT_SLOT,
  DRAFT_TTL_MS,
  POLICY_DRAFT_BASE,
} from "../../lib/guard/drafts.ts";
import { EMPTY_DRAFT, type PolicyDraft } from "../../lib/guard/policyForm.ts";
import { formatSalt, randomSalt } from "../../lib/guard/saltGenerator.ts";

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

const GUARD_A = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

function policyKey(guard: string): string {
  return scopedStorageKey(POLICY_DRAFT_BASE, NETWORK.name, guard);
}

function deployKey(): string {
  return scopedStorageKey(DEPLOY_DRAFT_BASE, NETWORK.name, DEPLOY_DRAFT_SLOT);
}

function seedPolicyDraft(draft: PolicyDraft, savedAt = Date.now()): void {
  window.localStorage.setItem(policyKey(GUARD_A), JSON.stringify({ v: 1, savedAt, draft }));
}

function seedDeployDraft(draft: Record<string, unknown>, savedAt = Date.now()): void {
  window.localStorage.setItem(deployKey(), JSON.stringify({ v: 1, savedAt, draft }));
}

/** Minimal GuardContext: the panels read these fields and nothing else crashes. */
function mockGuardContext(overrides: Partial<GuardContextValue> = {}): GuardContextValue {
  const base = {
    server: {},
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => ({ sign: async () => ({}) }),
    instances: [],
    guard: GUARD_A,
    selectGuard: () => {},
    addInstance: async () => ({ ok: true }),
    snapshot: null,
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
    session: {
      state: "idle" as const,
      timeoutMs: 0,
      setTimeoutMs: () => {},
      stayConnected: () => {},
    },
  };
  return { ...base, ...overrides } as unknown as GuardContextValue;
}

/** Mount one panel inside its providers and return the container. */
async function mount(element: unknown, value: GuardContextValue) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value },
        react.createElement(GuardEventsContext.Provider, { value: [] }, element as never),
      ),
    );
  });
  // Flush the requestAnimationFrame-deferred setState that restores drafts
  // (see DashboardGrid's persisted-layout pattern), so assertions below see the
  // restored form immediately after mount rather than one frame later.
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
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

async function mountPolicyForm(value?: Partial<GuardContextValue>) {
  return mount(react.createElement(PolicyForm), mockGuardContext(value));
}

async function mountDeployPanel(value?: Partial<GuardContextValue>) {
  return mount(react.createElement(DeployPanel), mockGuardContext(value));
}

function banner(container: HTMLElement): Element | null {
  return container.querySelector(
    '[data-testid="policy-draft-restored"], [data-testid="deploy-draft-restored"]',
  );
}

// ── PolicyForm ─────────────────────────────────────────────────────────────

test("policy form: a fresh draft is restored into the form, with a banner", async () => {
  const draft: PolicyDraft = { ...EMPTY_DRAFT, perTxCap: "12345", recipients: "GRECIPIENT" };
  seedPolicyDraft(draft);
  const mounted = await mountPolicyForm();
  try {
    const found = banner(mounted.container);
    assert.ok(found, "the restore banner must render");
    assert.match(found.textContent ?? "", /Draft restored/);
    const perTxCap = mounted.container.querySelector<HTMLInputElement>('input[value="12345"]');
    assert.ok(perTxCap, "the restored per-tx cap value must be in the form");
  } finally {
    await mounted.unmount();
    window.localStorage.clear();
  }
});

test("policy form: Discard draft clears the form and forgets storage", async () => {
  seedPolicyDraft({ ...EMPTY_DRAFT, perTxCap: "12345" });
  const mounted = await mountPolicyForm();
  try {
    const button = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="policy-draft-restored"] button',
    );
    assert.ok(button, "the banner must offer a discard button");
    await act(async () => {
      button.click();
      await sleep(0);
    });
    assert.equal(banner(mounted.container), null, "the banner disappears");
    assert.equal(
      window.localStorage.getItem(policyKey(GUARD_A)),
      null,
      "the stored draft is forgotten",
    );
    assert.equal(
      mounted.container.querySelector('input[value="12345"]'),
      null,
      "the form falls back to the installed/empty policy",
    );
  } finally {
    await mounted.unmount();
    window.localStorage.clear();
  }
});

test("policy form: no stored draft means no banner and a clean mount", async () => {
  const mounted = await mountPolicyForm();
  try {
    assert.equal(banner(mounted.container), null);
  } finally {
    await mounted.unmount();
    window.localStorage.clear();
  }
});

test("policy form: an expired draft does not restore, and the key is purged", async () => {
  seedPolicyDraft({ ...EMPTY_DRAFT, perTxCap: "999" }, Date.now() - DRAFT_TTL_MS - 1000);
  const mounted = await mountPolicyForm();
  try {
    assert.equal(banner(mounted.container), null, "an expired draft shows no banner");
    assert.equal(
      window.localStorage.getItem(policyKey(GUARD_A)),
      null,
      "an expired draft is purged on read",
    );
  } finally {
    await mounted.unmount();
    window.localStorage.clear();
  }
});

// ── DeployPanel ────────────────────────────────────────────────────────────

test("deploy panel: a seeded draft is restored, with a banner", async () => {
  const salt = randomSalt();
  const pubkeyHex = "c".repeat(64);
  seedDeployDraft({
    saltHex: formatSalt(salt),
    saltEncoding: "hex",
    saltText: "",
    agentPubkeyHex: pubkeyHex,
    agentAddress: "GBUQAGENT",
    dmsDurationSecs: "3600",
    perTxCap: "1000",
    windowCap: "5000",
  });
  const mounted = await mountDeployPanel();
  try {
    const found = banner(mounted.container);
    assert.ok(found, "the restore banner must render");
    assert.match(found.textContent ?? "", /Draft restored/);
    const pubkey = mounted.container.querySelector<HTMLInputElement>(`input[value="${pubkeyHex}"]`);
    assert.ok(pubkey, "the restored agent pubkey must be in the form");
    const dms = mounted.container.querySelector<HTMLInputElement>('input[value="3600"]');
    assert.ok(dms, "the restored dead-man grace must be in the form");
  } finally {
    await mounted.unmount();
    window.localStorage.clear();
  }
});

test("deploy panel: Discard draft resets the form and forgets storage", async () => {
  const pubkeyHex = "c".repeat(64);
  seedDeployDraft({
    saltHex: formatSalt(randomSalt()),
    saltEncoding: "hex",
    saltText: "",
    agentPubkeyHex: pubkeyHex,
    agentAddress: "",
    dmsDurationSecs: "",
    perTxCap: "",
    windowCap: "",
  });
  const mounted = await mountDeployPanel();
  try {
    const button = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="deploy-draft-restored"] button',
    );
    assert.ok(button, "the banner must offer a discard button");
    await act(async () => {
      button.click();
      await sleep(0);
    });
    assert.equal(banner(mounted.container), null);
    assert.equal(window.localStorage.getItem(deployKey()), null);
    assert.equal(
      mounted.container.querySelector(`input[value="${pubkeyHex}"]`),
      null,
      "the form falls back to blank",
    );
  } finally {
    await mounted.unmount();
    window.localStorage.clear();
  }
});

test("deploy panel: no stored draft means no banner and a clean mount", async () => {
  const mounted = await mountDeployPanel();
  try {
    assert.equal(banner(mounted.container), null);
  } finally {
    await mounted.unmount();
    window.localStorage.clear();
  }
});
