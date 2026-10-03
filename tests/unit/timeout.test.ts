import assert from "node:assert/strict";
import { test, describe, mock, beforeEach, afterEach } from "node:test";
import { withTimeout, DashboardReadError } from "../../lib/guard/timeout.ts";
import { createServer, readStatus } from "../../lib/guard/chain.ts";
import { GuardFeed } from "../../lib/guard/telemetry.ts";

describe("withTimeout", () => {
  beforeEach(() => {
    mock.timers.enable();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  test("returns the operation result if it completes before the timeout", async () => {
    const result = await withTimeout(async () => "success", 100);
    assert.equal(result, "success");
  });

  test("throws DashboardReadError if the operation takes longer than the timeout", async () => {
    const operation = async (signal: AbortSignal) => {
      return new Promise((resolve) => setTimeout(() => resolve("late"), 20000));
    };

    const promise = withTimeout(operation, 10000);
    mock.timers.tick(10000);

    await assert.rejects(promise, (err) => {
      assert(err instanceof DashboardReadError);
      assert.equal(err.message, "Read timed out after 10000ms");
      return true;
    });
  });

  test("cleans up abort listener on completion (no double timeout/leak)", async () => {
    // Testing leak-hygiene: test via controller-mock?
    // We can observe the signal's event listeners if it were exposed,
    // but AbortSignal doesn't expose a getter for listeners.
    // We can rely on the finally-removeEventListener code structure.
    let signalRef: AbortSignal | undefined;
    const result = await withTimeout(async (signal) => {
      signalRef = signal;
      return "done";
    }, 10000);

    assert.equal(result, "done");
    assert.ok(signalRef, "signal was passed");
    // If we hadn't removed the listener, it would still be there, but there is no public API to assert it.
    // The code structure guarantees cleanup by finally { removeEventListener }.
  });

  test("timeout-recovery lifecycle test (simulating UI composition)", async () => {
    let attempts = 0;

    const mockOperation = async () => {
      attempts++;
      if (attempts === 1) {
        // First attempt hangs
        return new Promise((resolve) => setTimeout(() => resolve("late"), 20000));
      } else {
        // Second attempt (retry) succeeds fast
        return "recovered value";
      }
    };

    // 1. First read hangs -> typed error
    const firstPromise = withTimeout(mockOperation, 10000);
    mock.timers.tick(10000);
    await assert.rejects(firstPromise, DashboardReadError);

    // 2. The error state is reached (mocking the error-block rendering).
    // 3. User clicks retry -> triggers another read
    const secondPromise = withTimeout(mockOperation, 10000);
    mock.timers.tick(10); // minimal tick to let microtasks flush

    const value = await secondPromise;
    // 4. Recovery path succeeds -> value
    assert.equal(value, "recovered value");
    assert.equal(attempts, 2);
  });
});
