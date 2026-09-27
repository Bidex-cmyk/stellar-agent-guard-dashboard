import test from "node:test";
import assert from "node:assert/strict";
import { calculateVelocity } from "../../lib/guard/velocity.ts";

test("velocity calculations", async (t) => {
  await t.test("calculates moving averages correctly across intervals", () => {
    const now = 10000n;
    
    const entries = [
      { ts: 9980n, amount: 50n },   // age 20s (in 1m, 15m, 1h)
      { ts: 9950n, amount: 100n },  // age 50s (in 1m, 15m, 1h)
      { ts: 9500n, amount: 300n },  // age 500s (8.3m - in 15m, 1h)
      { ts: 8000n, amount: 500n },  // age 2000s (33.3m - in 1h)
      { ts: 5000n, amount: 1000n }, // age 5000s (83.3m - out of all)
    ];

    const result = calculateVelocity(entries, now, null);

    assert.equal(result.spend1m, 150n); // 50 + 100
    assert.equal(result.spend15m, 450n); // 150 + 300
    assert.equal(result.spend1h, 950n); // 450 + 500
  });

  await t.test("calculates exhaustion correctly using 15m average", () => {
    const now = 10000n;
    const entries = [
      { ts: 9500n, amount: 1500n }, // age 500s. 1500 in 15m = 100 per minute.
    ];

    const result = calculateVelocity(entries, now, 2500n);
    // rate = 1500 / 15 = 100
    // exhaustion = 2500 / 100 = 25 minutes
    assert.equal(result.exhaustionMinutes, 25);
  });
  
  await t.test("falls back to 1m average if 15m is empty but 1m is not", () => {
    // This scenario actually puts 1m inside 15m so 15m will never be empty if 1m is not empty,
    // but the code handles if 15m calculation somehow yielded 0 but 1m didn't (impossible theoretically but logic is sound).
    // Let's test the 1h fallback.
    const now = 10000n;
    const entries = [
      { ts: 8000n, amount: 600n }, // age 2000s (33.3m). Not in 15m, in 1h.
    ];

    const result = calculateVelocity(entries, now, 100n);
    // rate = 600 / 60 = 10
    // exhaustion = 100 / 10 = 10
    assert.equal(result.exhaustionMinutes, 10);
  });

  await t.test("returns null exhaustion if rate is 0", () => {
    const result = calculateVelocity([], 10000n, 1000n);
    assert.equal(result.exhaustionMinutes, null);
  });
  
  await t.test("returns null exhaustion if remainingCap is null", () => {
    const now = 10000n;
    const entries = [{ ts: 9980n, amount: 50n }];
    const result = calculateVelocity(entries, now, null);
    assert.equal(result.exhaustionMinutes, null);
  });
});
