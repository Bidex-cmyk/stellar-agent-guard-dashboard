import assert from "node:assert/strict";
import { before, test } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { HardwareWalletGuide } from "../../components/HardwareWalletGuide.tsx";
import {
  HardwareGuideStore,
  formatHashForDevice,
  hardwareGuide,
} from "../../lib/guard/hardwareGuide.ts";

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

const CONTRACT = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const HASH64 = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("an idle store reports no active session", () => {
  const store = new HardwareGuideStore();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.session, null);
});

test("begin opens a signing session with no hash yet", () => {
  const store = new HardwareGuideStore();
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  store.begin(CONTRACT, "set_policy");
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.session?.contractId, CONTRACT);
  assert.equal(snapshot.session?.method, "set_policy");
  assert.equal(snapshot.session?.txHash, null);
  assert.equal(notified, 1);
});

test("setTxHash records the hash, and is ignored when not signing", () => {
  const store = new HardwareGuideStore();
  store.setTxHash(HASH64); // no session yet → ignored
  assert.equal(store.getSnapshot().active, false);

  store.begin(CONTRACT, "freeze");
  store.setTxHash(HASH64);
  assert.equal(store.getSnapshot().session?.txHash, HASH64);
});

test("clear dismisses the session, and clearing an idle store does not notify", () => {
  const store = new HardwareGuideStore();
  store.begin(CONTRACT, "freeze");
  store.clear();
  assert.equal(store.getSnapshot().active, false);
  assert.equal(store.getSnapshot().session, null);

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  store.clear(); // already idle
  assert.equal(notified, 0, "a no-op clear must not churn subscribers");
});

test("getSnapshot is referentially stable between changes", () => {
  const store = new HardwareGuideStore();
  const before = store.getSnapshot();
  store.getSnapshot();
  assert.equal(store.getSnapshot(), before, "idle snapshot is the same object");
  store.begin(CONTRACT, "unfreeze");
  const active = store.getSnapshot();
  assert.equal(store.getSnapshot(), active, "active snapshot is cached until it changes");
});

test("formatHashForDevice uppercases and groups the hash into 8-character blocks", () => {
  const formatted = formatHashForDevice(HASH64);
  assert.equal(
    formatted,
    "A1B2C3D4 E5F60718 293A4B5C 6D7E8F90 A1B2C3D4 E5F60718 293A4B5C 6D7E8F90",
  );
  // Grouping preserves every character — nothing is dropped for readability.
  assert.equal(formatted.replace(/ /g, ""), HASH64.toUpperCase());
});

test("formatHashForDevice tolerates a 0x prefix, and passes non-hex through unchanged", () => {
  assert.equal(formatHashForDevice(`0x${HASH64.slice(0, 8)}`), HASH64.slice(0, 8).toUpperCase());
  assert.equal(formatHashForDevice(null), "");
  assert.equal(formatHashForDevice("preparing"), "preparing");
});

/** Mount the guide, returning helpers to read and drive it. */
async function mountGuide() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(react.createElement(HardwareWalletGuide));
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

test("the guide renders nothing while no session is active", async () => {
  hardwareGuide.clear();
  const mounted = await mountGuide();
  try {
    assert.equal(mounted.container.querySelector('[role="dialog"]'), null);
  } finally {
    await mounted.unmount();
  }
});

test("begin shows the dialog; setTxHash renders the grouped hash; clear dismisses it", async () => {
  hardwareGuide.clear();
  const mounted = await mountGuide();
  try {
    await act(async () => {
      hardwareGuide.begin(CONTRACT, "freeze");
      await sleep(0);
    });

    const dialog = mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, "the guide must appear while signing");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.match(dialog.textContent ?? "", /freeze/, "the method is shown");

    // Before the hash is known the dialog says so rather than showing a blank.
    assert.match(dialog.textContent ?? "", /Preparing transaction/);

    await act(async () => {
      hardwareGuide.setTxHash(HASH64);
      await sleep(0);
    });
    assert.ok(
      (dialog.textContent ?? "").includes("A1B2C3D4 E5F60718"),
      "the grouped hash is displayed for on-device comparison",
    );

    await act(async () => {
      hardwareGuide.clear();
      await sleep(0);
    });
    assert.equal(
      mounted.container.querySelector('[role="dialog"]'),
      null,
      "confirming the signature auto-dismisses the guide",
    );
  } finally {
    hardwareGuide.clear();
    await mounted.unmount();
  }
});
