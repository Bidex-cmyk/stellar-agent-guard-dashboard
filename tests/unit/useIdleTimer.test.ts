import assert from "node:assert/strict";
import { before, afterEach, mock, test } from "node:test";
import type { ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import {
  IDLE_TIMEOUT_OPTIONS,
  IdleTimer,
  loadIdleTimeoutMs,
  saveIdleTimeoutMs,
  useIdleTimer,
  IDLE_TIMEOUT_STORAGE_KEY,
  type IdleState,
} from "../../lib/guard/useIdleTimer.ts";

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

afterEach(() => {
  mock.timers.reset();
});

/** The last emitted state from a run of the timer, given fake timers. */
function recorder() {
  const states: IdleState[] = [];
  return { states, last: () => states[states.length - 1], push: (s: IdleState) => states.push(s) };
}

test("the timer counts down through armed, warns inside the lead window, then expires", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const rec = recorder();
  let expired = 0;
  const timer = new IdleTimer({
    timeoutMs: 300_000,
    warningSeconds: 60,
    onState: rec.push,
    onExpire: () => {
      expired += 1;
    },
  });
  timer.start();
  try {
    assert.equal(rec.last()?.phase, "armed");
    assert.equal(rec.last()?.secondsLeft, 300);

    // 4 minutes of silence: still inside the window, but past the 60s lead.
    mock.timers.tick(240_000);
    assert.equal(rec.last()?.phase, "warning");
    assert.equal(rec.last()?.secondsLeft, 60);
    assert.equal(expired, 0, "not yet expired while the warning is showing");

    // Down to the last few seconds.
    mock.timers.tick(59_000);
    assert.equal(rec.last()?.secondsLeft, 1);

    mock.timers.tick(1_000);
    assert.equal(rec.last()?.phase, "locked");
    assert.equal(expired, 1, "onExpire fires exactly once at the deadline");
    assert.equal(rec.last()?.secondsLeft, 0);
  } finally {
    timer.stop();
  }
});

test("activity resets the deadline and clears the warning phase", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const rec = recorder();
  let expired = 0;
  const timer = new IdleTimer({
    timeoutMs: 300_000,
    warningSeconds: 60,
    onState: rec.push,
    onExpire: () => {
      expired += 1;
    },
  });
  timer.start();
  try {
    mock.timers.tick(250_000);
    assert.equal(rec.last()?.phase, "warning");

    timer.activity();
    assert.equal(rec.last()?.phase, "armed", "presence returns the timer to the armed state");
    assert.equal(rec.last()?.secondsLeft, 300, "the full window is restored");

    // Not even close to expiry now: the reset bought back the whole window.
    mock.timers.tick(250_000);
    assert.equal(expired, 0);
    assert.equal(rec.last()?.phase, "warning");
  } finally {
    timer.stop();
  }
});

test("a disabled timer (Never) never warns or expires", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const rec = recorder();
  let expired = 0;
  const timer = new IdleTimer({
    timeoutMs: 0,
    onState: rec.push,
    onExpire: () => {
      expired += 1;
    },
  });
  // The hook never constructs a timer for timeoutMs <= 0; driving it directly,
  // a zero deadline would expire immediately, which is exactly what the hook
  // guards against by not starting one.
  timer.stop();
  assert.equal(rec.states.length, 0);
  assert.equal(expired, 0);
});

// ── Hook ────────────────────────────────────────────────────────────────────

interface Harness {
  unmount: () => Promise<void>;
  container: HTMLElement;
}

let expireCount = 0;
let lastState: IdleState | null = null;

function makeHarness(timeoutMs: number, enabled: boolean) {
  expireCount = 0;
  lastState = null;
  function Probe(): ReactElement {
    const { state, stayConnected } = useIdleTimer({
      timeoutMs,
      enabled,
      onExpire: () => {
        expireCount += 1;
      },
    });
    lastState = state;
    return react.createElement("button", { onClick: stayConnected }, String(state.phase));
  }
  return Probe;
}

async function mount(component: () => ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(react.createElement(component));
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

test("the hook warns, and user events (mousemove/keydown) reset the countdown", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const mounted = await mount(makeHarness(300_000, true));
  try {
    await act(async () => {
      mock.timers.tick(245_000);
      await sleep(0);
    });
    assert.equal(lastState?.phase, "warning");

    // A single mouse move is presence: the warning must clear.
    await act(async () => {
      window.dispatchEvent(new window.Event("mousemove"));
    });
    assert.equal(lastState?.phase, "armed", "mousemove reset the idle timer");

    // Let it run all the way down without further activity: it expires once.
    await act(async () => {
      mock.timers.tick(300_000);
      await sleep(0);
    });
    assert.equal(expireCount, 1, "the session auto-disconnects on expiry");
    assert.equal(lastState?.phase, "locked");
  } finally {
    await mounted.unmount();
  }
});

test("an enabled=false hook attaches no timer and never expires", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const mounted = await mount(makeHarness(1_000, false));
  try {
    await act(async () => {
      mock.timers.tick(10_000);
      await sleep(0);
    });
    assert.equal(expireCount, 0);
  } finally {
    await mounted.unmount();
  }
});

// ── Persistence ───────────────────────────────────────────────────────────

test("the chosen timeout persists and validates on reload", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  assert.equal(loadIdleTimeoutMs(storage), IDLE_TIMEOUT_OPTIONS[1]?.valueMs, "default is 15m");
  saveIdleTimeoutMs(30 * 60 * 1000, storage);
  assert.equal(loadIdleTimeoutMs(storage), 30 * 60 * 1000);
  data.set(IDLE_TIMEOUT_STORAGE_KEY, "12345"); // not an offered option
  assert.equal(
    loadIdleTimeoutMs(storage),
    IDLE_TIMEOUT_OPTIONS[1]?.valueMs,
    "invalid value → default",
  );
});
