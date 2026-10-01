import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTransactionEnvelope, detectExpiration } from "../../lib/guard/submit.ts";

describe("createTransactionEnvelope", () => {
  it("sets default TimeBounds of -60s / +300s around the current time", () => {
    const now = 1000;
    const { minTime, maxTime } = createTransactionEnvelope(now);
    assert.equal(minTime, 940);
    assert.equal(maxTime, 1300);
  });

  it("honours custom minOffset and maxOffset", () => {
    const { minTime, maxTime } = createTransactionEnvelope(1000, 100, 500);
    assert.equal(minTime, 900);
    assert.equal(maxTime, 1500);
  });
});

describe("detectExpiration", () => {
  it("returns true when currentTime equals maxTime", () => {
    assert.equal(detectExpiration(1300, 1300), true);
  });

  it("returns false when currentTime is before maxTime", () => {
    assert.equal(detectExpiration(1299, 1300), false);
  });
});
