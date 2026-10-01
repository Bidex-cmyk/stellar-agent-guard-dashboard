import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { memoryWiper } from "../../lib/guard/memoryWiper.ts";

describe("memoryWiper", () => {
  it("executes registered callbacks on wipe", () => {
    const cb1 = mock.fn();
    const cb2 = mock.fn();

    const unreg1 = memoryWiper.add(cb1);
    memoryWiper.add(cb2);

    memoryWiper.wipe();

    assert.equal(cb1.mock.callCount(), 1);
    assert.equal(cb2.mock.callCount(), 1);

    unreg1();
  });

  it("deregisters callbacks correctly", () => {
    const cb1 = mock.fn();
    const unreg1 = memoryWiper.add(cb1);

    unreg1();
    memoryWiper.wipe();

    assert.equal(cb1.mock.callCount(), 0);
  });

  it("clears sessionStorage if available", () => {
    let cleared = false;
    global.window = {
      sessionStorage: { clear: () => { cleared = true; } },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as any;

    memoryWiper.wipe();
    assert.equal(cleared, true);

    delete (global as any).window;
  });

  it("registers and unregisters window event listeners", () => {
    const listeners = new Map<string, Function>();
    global.window = {
      sessionStorage: { clear: () => {} },
      addEventListener: (evt: string, cb: Function) => listeners.set(evt, cb),
      removeEventListener: (evt: string) => listeners.delete(evt),
    } as any;

    const unregister = memoryWiper.registerBrowserEvents();
    assert.ok(listeners.has("pagehide"));
    assert.ok(listeners.has("beforeunload"));

    unregister();
    assert.ok(!listeners.has("pagehide"));
    assert.ok(!listeners.has("beforeunload"));

    delete (global as any).window;
  });
});
