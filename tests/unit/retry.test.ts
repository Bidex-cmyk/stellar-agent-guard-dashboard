import assert from "node:assert/strict";
import { test } from "node:test";
import { RetryableError, withBackoff } from "../../lib/guard/retry.ts";

/**
 * Runs `operation` with `setTimeout` and `Math.random` stubbed so the backoff
 * delays can be captured without actually waiting, and with jitter made
 * deterministic.
 */
async function captureDelays(random: number, operation: () => Promise<unknown>): Promise<number[]> {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realRandom = Math.random;

  Math.random = () => random;
  globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
    delays.push(timeout ?? 0);
    return realSetTimeout(handler, 0);
  }) as typeof setTimeout;

  try {
    await operation();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    Math.random = realRandom;
  }

  return delays;
}

test("retries retryable failures with an exponentially growing delay", async () => {
  let calls = 0;
  const delays = await captureDelays(1, () =>
    withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new RetryableError("RPC TIMEOUT");
        return "ok";
      },
      { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 8000 },
    ),
  );

  // With Math.random() === 1 the jitter equals the whole computed delay.
  assert.deepEqual(delays, [500, 1000], "each retry doubles the previous delay");
  assert.equal(calls, 3);
});

test("applies jitter drawn from the current delay", async () => {
  let calls = 0;
  const delays = await captureDelays(0.25, () =>
    withBackoff(
      async () => {
        calls += 1;
        if (calls < 2) throw new RetryableError("TRY_AGAIN_LATER");
        return calls;
      },
      { maxRetries: 3, baseDelayMs: 400 },
    ),
  );

  assert.deepEqual(delays, [100], "jitter is 0.25 × the 400 ms base delay");
});

test("does not retry or wait on a non-retryable error", async () => {
  let calls = 0;
  let scheduled = 0;
  const realSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
    scheduled += 1;
    return realSetTimeout(handler, timeout);
  }) as typeof setTimeout;

  try {
    await assert.rejects(
      () =>
        withBackoff(
          async () => {
            calls += 1;
            throw new Error("Invalid contract id");
          },
          { maxRetries: 5, baseDelayMs: 10 },
        ),
      /Invalid contract id/,
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(calls, 1, "the operation is attempted once");
  assert.equal(scheduled, 0, "no retry delay is scheduled");
});

test("rethrows after exhausting maxRetries", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withBackoff(
        async () => {
          calls += 1;
          throw new RetryableError("NOT_FOUND");
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 },
      ),
    /NOT_FOUND/,
  );
  assert.equal(calls, 3, "one initial attempt plus maxRetries retries");
});
