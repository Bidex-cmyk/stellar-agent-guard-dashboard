import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatRawStroops,
  formatStroops,
  formatStroopsWithUnit,
} from "../../lib/guard/formatters.ts";

describe("formatStroops", () => {
  it("groups a standard 10,000 XLM value without floats", () => {
    assert.equal(formatStroops(100_000_000_000n), "10,000.0000000");
  });

  it("renders a single stroop and zero exactly", () => {
    assert.equal(formatStroops(1n), "0.0000001");
    assert.equal(formatStroops(0n), "0.0000000");
  });

  it("handles multi-billion XLM magnitudes exactly", () => {
    // 2.5B XLM = 25_000_000_000_000_000 stroops — beyond float precision.
    assert.equal(formatStroops(25_000_000_000_000_000n), "2,500,000,000.0000000");
  });

  it("accepts number and string inputs", () => {
    assert.equal(formatStroops(10_000_000), "1.0000000");
    assert.equal(formatStroops("10000000"), "1.0000000");
  });

  it("supports custom symbols and decimals", () => {
    assert.equal(formatStroops(1_500_000n, { symbol: "USDC", decimals: 6 }), "1.500000");
    assert.equal(formatStroops(1500n, { decimals: 0 }), "1,500");
  });

  it("rejects negative and non-integer input", () => {
    assert.throws(() => formatStroops(-1n), RangeError);
    assert.throws(() => formatStroops(1.5), RangeError);
    assert.throws(() => formatStroops("abc"), RangeError);
  });
});

describe("formatStroopsWithUnit / formatRawStroops", () => {
  it("pairs human and raw forms for the toggle", () => {
    assert.equal(formatStroopsWithUnit(100_000_000_000n), "10,000.0000000 XLM");
    assert.equal(formatRawStroops(100_000_000_000n), "100,000,000,000 stroops");
  });

  it("honours a custom symbol", () => {
    assert.equal(
      formatStroopsWithUnit(2_000_000n, { symbol: "USDC", decimals: 6 }),
      "2.000000 USDC",
    );
  });
});
