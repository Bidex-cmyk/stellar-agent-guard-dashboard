import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateFeeHeadroom } from "../../lib/guard/feeEstimator.ts";

describe("calculateFeeHeadroom", () => {
  it("applies 15% CPU headroom with Standard preset by default", () => {
    const res = calculateFeeHeadroom(1000, 1000n);
    assert.equal(res.cpu, 1150);
    assert.equal(res.fee, 1150n);
  });

  it("applies 5% CPU headroom with Economic preset", () => {
    const res = calculateFeeHeadroom(1000, 1000n, "Economic");
    assert.equal(res.cpu, 1050);
    assert.equal(res.fee, 1050n);
  });

  it("applies 30% CPU headroom with Fast preset", () => {
    const res = calculateFeeHeadroom(1000, 1000n, "Fast");
    assert.equal(res.cpu, 1300);
    assert.equal(res.fee, 1300n);
  });

  it("clamps padded fee to maxFeeCap when exceeded", () => {
    const res = calculateFeeHeadroom(1000, 1000n, "Fast", 1200n);
    assert.equal(res.cpu, 1300);
    assert.equal(res.fee, 1200n);
  });

  it("does not overflow on large BigInt stroop amounts", () => {
    const bigFee = BigInt("9007199254740993"); // > Number.MAX_SAFE_INTEGER
    const res = calculateFeeHeadroom(100, bigFee, "Standard");
    assert.equal(typeof res.fee, "bigint");
    assert.ok(res.fee > bigFee, "padded fee should exceed base fee");
  });
});
