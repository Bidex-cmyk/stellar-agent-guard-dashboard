import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PUBLIC_PASSPHRASE,
  TESTNET_PASSPHRASE,
  classifySwitchFailure,
  detectNetworkMismatch,
  describeMismatch,
  describeSwitchOutcome,
  loadFreighterNetworkApi,
  manualSwitchInstructions,
  mismatchExplanation,
  networkDisplayName,
  requestFreighterNetworkSwitch,
  switchButtonLabel,
  type FreighterNetworkApi,
} from "../../lib/guard/networkSwitch.ts";

/**
 * A mismatch is the failure mode that makes this dashboard look broken when
 * nothing is broken, so the tests pin both halves: spotting it, and what the
 * one-click fix does when the wallet says no.
 */

const TARGET = { targetPassphrase: TESTNET_PASSPHRASE, targetNetwork: "testnet" };

function fakeFreighterNetworkApi(
  options: {
    networkAccess?: FreighterNetworkApi["requestNetworkAccess"];
    details?: { network?: string; networkPassphrase?: string; error?: unknown };
  } = {},
): FreighterNetworkApi {
  return {
    ...(options.networkAccess ? { requestNetworkAccess: options.networkAccess } : {}),
    getNetworkDetails: async () => options.details ?? { network: "TESTNET", networkPassphrase: TESTNET_PASSPHRASE },
  };
}

describe("mismatch detection", () => {
  it("stays silent when the wallet and the dashboard agree", () => {
    assert.equal(detectNetworkMismatch(TESTNET_PASSPHRASE, TESTNET_PASSPHRASE, { targetNetwork: "testnet" }), null);
  });

  it("reports a Mainnet wallet against a Testnet dashboard", () => {
    const mismatch = detectNetworkMismatch(PUBLIC_PASSPHRASE, TESTNET_PASSPHRASE, { targetNetwork: "testnet" });
    assert.ok(mismatch);
    assert.equal(mismatch.walletPassphrase, PUBLIC_PASSPHRASE);
    assert.equal(mismatch.targetPassphrase, TESTNET_PASSPHRASE);
    assert.equal(mismatch.walletNetwork, "public");
    assert.equal(mismatch.targetNetwork, "testnet");
  });

  it("treats an unknown wallet network as a mismatch, because 'unknown' is not 'agrees'", () => {
    assert.notEqual(detectNetworkMismatch("", TESTNET_PASSPHRASE), null);
    assert.notEqual(detectNetworkMismatch(null, TESTNET_PASSPHRASE), null);
    assert.notEqual(detectNetworkMismatch(undefined, TESTNET_PASSPHRASE), null);
    const mismatch = detectNetworkMismatch(null, TESTNET_PASSPHRASE)!;
    assert.equal(mismatch.walletNetwork, "unknown");
    assert.equal(describeMismatch(mismatch), "Wallet on an unknown network, dashboard on Testnet.");
  });

  it("works in the other direction too, since Testnet dashboards are not the only ones", () => {
    const mismatch = detectNetworkMismatch(TESTNET_PASSPHRASE, PUBLIC_PASSPHRASE, {
      targetNetwork: "public",
    })!;
    assert.equal(
      describeMismatch(mismatch),
      "Wallet on Testnet, dashboard on Mainnet.",
    );
  });
});

describe("the wording operators see", () => {
  it("names both sides in the warning bar headline", () => {
    const mismatch = detectNetworkMismatch(PUBLIC_PASSPHRASE, TESTNET_PASSPHRASE, { targetNetwork: "testnet" })!;
    assert.equal(describeMismatch(mismatch), "Wallet on Mainnet, dashboard on Testnet.");
    assert.equal(switchButtonLabel(mismatch), "Switch wallet to Testnet");
    assert.match(mismatchExplanation(mismatch), /cannot authorize/);
    assert.match(mismatchExplanation(mismatch), /nothing has been sent/i);
  });

  it("spells the known networks and admits the rest", () => {
    assert.equal(networkDisplayName({ passphrase: PUBLIC_PASSPHRASE }), "Mainnet");
    assert.equal(networkDisplayName({ passphrase: TESTNET_PASSPHRASE }), "Testnet");
    assert.equal(networkDisplayName({ passphrase: "Test SDF Future Network ; October 2022" }), "Futurenet");
    assert.equal(networkDisplayName({ passphrase: null, name: "testnet" }), "Testnet");
    assert.equal(networkDisplayName({ passphrase: null }), "an unknown network");
    assert.equal(networkDisplayName({ passphrase: "Something ; 2031" }), "an unknown network");
  });

  it("keeps the manual fallback specific enough to act on", () => {
    const mismatch = detectNetworkMismatch(PUBLIC_PASSPHRASE, TESTNET_PASSPHRASE, { targetNetwork: "testnet" })!;
    const steps = manualSwitchInstructions(mismatch);
    assert.ok(steps.length >= 2);
    assert.ok(steps.every((step) => step.includes("Testnet")));
  });
});

describe("requesting the switch from Freighter", () => {
  it("confirms the switch from what the wallet reports afterwards", async () => {
    const requested: string[] = [];
    const api = fakeFreighterNetworkApi({
      networkAccess: async ({ network }) => {
        requested.push(network);
        return { isChanged: true };
      },
      details: { network: "TESTNET", networkPassphrase: TESTNET_PASSPHRASE },
    });

    const outcome = await requestFreighterNetworkSwitch({ api, ...TARGET });
    assert.deepEqual(requested, ["testnet"], "Freighter is asked by its own network name");
    assert.equal(outcome.kind, "switched");
    assert.ok(outcome.kind === "switched" && outcome.passphrase === TESTNET_PASSPHRASE);
  });

  it("reports a dismissed prompt as declined, not as a failure", async () => {
    const api = fakeFreighterNetworkApi({
      networkAccess: async () => undefined,
      details: { network: "PUBLIC", networkPassphrase: PUBLIC_PASSPHRASE },
    });
    const outcome = await requestFreighterNetworkSwitch({ api, ...TARGET });
    assert.equal(outcome.kind, "declined");
    assert.match(outcome.message, /still on Mainnet/);
    assert.equal(describeSwitchOutcome(outcome).tone, "warn");
  });

  it("reads an explicit error reply, including the older isError shape", async () => {
    const declined = await requestFreighterNetworkSwitch({
      api: fakeFreighterNetworkApi({
        networkAccess: async () => ({ isError: true, error: "user rejected the request" }),
      }),
      ...TARGET,
    });
    assert.equal(declined.kind, "declined");

    const failed = await requestFreighterNetworkSwitch({
      api: fakeFreighterNetworkApi({
        networkAccess: async () => ({ isError: true, error: "network not configured" }),
      }),
      ...TARGET,
    });
    assert.equal(failed.kind, "failed");
    assert.equal(describeSwitchOutcome(failed).tone, "danger");
  });

  it("turns a thrown rejection into the matching outcome", async () => {
    const outcome = await requestFreighterNetworkSwitch({
      api: fakeFreighterNetworkApi({
        networkAccess: async () => {
          throw new Error("User cancelled");
        },
      }),
      ...TARGET,
    });
    assert.equal(outcome.kind, "declined");
    assert.match(outcome.message, /cancelled/);
  });

  it("says plainly when this Freighter build has no switch request at all", async () => {
    const outcome = await requestFreighterNetworkSwitch({
      api: fakeFreighterNetworkApi({ details: { network: "PUBLIC", networkPassphrase: PUBLIC_PASSPHRASE } }),
      ...TARGET,
    });
    assert.equal(outcome.kind, "unsupported");
    assert.match(outcome.message, /does not expose a network-switch request/);
    assert.equal(describeSwitchOutcome(outcome).tone, "warn");
  });

  it("does not throw when there is no Freighter to ask", async () => {
    const outcome = await requestFreighterNetworkSwitch({ api: null, ...TARGET });
    assert.equal(outcome.kind, "unsupported");
  });

  it("reports a failure to re-read the network as failed rather than pretending", async () => {
    const api: FreighterNetworkApi = {
      requestNetworkAccess: async () => ({}),
      getNetworkDetails: async () => {
        throw new Error("wallet disconnected mid-request");
      },
    };
    const outcome = await requestFreighterNetworkSwitch({ api, ...TARGET });
    assert.equal(outcome.kind, "failed");
  });

  it("passes the dashboard's own network name through to the request", async () => {
    const seen: string[] = [];
    await requestFreighterNetworkSwitch({
      api: fakeFreighterNetworkApi({
        networkAccess: async ({ network }) => {
          seen.push(network);
          return {};
        },
        details: { network: "PUBLIC", networkPassphrase: PUBLIC_PASSPHRASE },
      }),
      targetPassphrase: PUBLIC_PASSPHRASE,
      targetNetwork: "mainnet",
    });
    assert.deepEqual(seen, ["public"], "mainnet is Freighter's 'public'");
  });
});

describe("separating a refusal from a breakdown", () => {
  it("classifies the words each wallet uses for no", () => {
    for (const message of ["User rejected", "permission denied", "request declined", "cancelled", "aborted"]) {
      assert.equal(classifySwitchFailure(message), "declined", message);
    }
    for (const message of ["network not configured", "extension disconnected", ""]) {
      assert.equal(classifySwitchFailure(message), "failed", message);
    }
  });

  it("summarizes every outcome with a tone and a sentence", () => {
    assert.equal(describeSwitchOutcome({ kind: "already", network: "testnet", passphrase: TESTNET_PASSPHRASE }).tone, "ok");
    assert.equal(
      describeSwitchOutcome({ kind: "switched", network: "testnet", passphrase: TESTNET_PASSPHRASE }).text,
      "The wallet is now on Testnet. Reconnect to resume signing.",
    );
    assert.equal(describeSwitchOutcome({ kind: "declined", message: "no" }).text, "no Nothing was signed.");
  });
});

describe("loading Freighter's network API", () => {
  it("yields null where there is no bundle and no extension", async () => {
    assert.equal(await loadFreighterNetworkApi(null), null);
    assert.equal(
      await loadFreighterNetworkApi(async () => {
        throw new Error("no extension");
      }),
      null,
    );
  });

  it("returns the module when it loads", async () => {
    const api = fakeFreighterNetworkApi();
    assert.equal(await loadFreighterNetworkApi(async () => api as never), api as never);
  });
});
