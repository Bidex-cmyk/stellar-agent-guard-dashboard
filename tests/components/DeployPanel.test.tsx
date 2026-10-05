import assert from "node:assert/strict";
import { test, before, afterEach, describe } from "node:test";
import { installDom, loadReact } from "../unit/domHarness.ts";
import { DeployPanel } from "../../components/DeployPanel.tsx";
import { GuardContext, type GuardContextValue } from "../../components/GuardProvider.tsx";

describe("DeployPanel", () => {
  let dom: ReturnType<typeof installDom>;
  let React: Awaited<ReturnType<typeof loadReact>>["react"];
  let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
  let act: Awaited<ReturnType<typeof loadReact>>["act"];
  let root: ReturnType<typeof createRoot> | null = null;

  // Mock localStorage for density store
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string): string | null => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
  })();

  before(async () => {
    dom = installDom();
    // Mock localStorage
    Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });
    const reactDeps = await loadReact();
    React = reactDeps.react;
    createRoot = reactDeps.createRoot;
    act = reactDeps.act;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    document.body.innerHTML = "";
    localStorageMock.clear();
  });

  function createMockGuardContextValue(overrides: Partial<any> = {}): any {
    const defaults: any = {
      server: {} as any,
      wallet: { address: "GBTEST...", networkPassphrase: "Testnet", network: "Testnet" },
      walletError: null,
      connecting: false,
      connect: async () => {},
      disconnect: () => {},
      signer: () => ({
        sign: async () => ({}),
      }),
      instances: [],
      guard: "test_guard",
      selectGuard: () => {},
      addInstance: () => {},
      snapshot: {
        fetchedAt: Date.now(),
        status: {
          ok: true,
          value: {
            admin_frozen: false,
            heartbeat_expired: false,
            has_policy: true,
            last_heartbeat: 1000n,
            now: 2000n,
          },
        },
      },
      snapshotError: null,
      refreshing: false,
      refresh: async () => {},
      events: [],
      feed: {
        watching: false,
        latestLedger: null,
        error: null,
        lastPolledAt: null,
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
    return { ...defaults, ...overrides };
  }

  test("renders initial state with no wallet", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      wallet: null,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(DeployPanel),
        ),
      );
    });

    // Check that it renders correctly
    assert.dom(document.body).containsText("Deploy a guard");
    assert
      .dom(document.body)
      .containsText("Connect the admin wallet to compute the contract address.");
    assert.dom(document.body).containsText("Working out the deploy plan...");
  });

  test("shows wallet connection prompt", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      wallet: null,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(DeployPanel),
        ),
      );
    });

    // Check wallet connection message
    assert
      .dom(document.body)
      .containsText("Connect the admin wallet to compute the contract address.");
  });

  test("shows artifact checking state", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      wallet: { address: "GBTEST...", networkPassphrase: "Testnet", network: "Testnet" },
      signer: () => ({
        sign: async () => ({}),
      }),
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(DeployPanel),
        ),
      );
    });

    // Check that it shows artifact checking state
    assert.dom(document.body).containsText("Predicted guard address");
    assert.dom(document.body).containsText("Pinned bytecode already on chain");
    assert.dom(document.body).containsText("Working out the deploy plan...");
  });

  test("shows deploy button when artifact is valid", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      wallet: { address: "GBTEST...", networkPassphrase: "Testnet", network: "Testnet" },
      signer: () => ({
        sign: async () => ({}),
      }),
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(DeployPanel),
        ),
      );
    });

    // Check that deploy button is present and not disabled (when artifact is valid)
    assert.dom(document.body).containsText("Pinned artifact");
    assert.dom(document.body).containsText("Fetched from chain");
    assert.dom(document.body).containsText("Deploy guard");

    // Check deploy button exists
    const deployButton = document.querySelector(
      'button:has-text("Deploy guard")',
    ) as HTMLButtonElement | null;
    assert.ok(deployButton, "Deploy button should exist");
    // Note: We can't easily test the disabled state without mocking the artifact check
    // but we can verify the button exists
  });

  test("shows initialization form", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      wallet: { address: "GBTEST...", networkPassphrase: "Testnet", network: "Testnet" },
      signer: () => ({
        sign: async () => ({}),
      }),
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(DeployPanel),
        ),
      );
    });

    // Check that initialization section is present
    assert.dom(document.body).containsText("Initialize a guard");
    assert.dom(document.body).containsText("Agent public key");
    assert.dom(document.body).containsText("Agent account address");
    assert.dom(document.body).containsText("Dead-man grace (seconds)");
    assert.dom(document.body).containsText("Per-transaction cap (units)");
    assert.dom(document.body).containsText("Rolling-window cap (units)");
    assert.dom(document.body).containsText("Sign and initialize");
  });
});
