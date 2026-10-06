import { test, before, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./domHarness.ts";
import { density, initDensityStore } from "../../lib/guard/densityStore.ts";

describe("densityStore", () => {
  let unsubscribe: () => void;

  before(() => {
    installDom();
  });

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  afterEach(() => {
    if (unsubscribe) {
      unsubscribe();
    }
    localStorage.clear();
  });

  test("initializes with comfortable density by default", () => {
    // Initialize the store
    unsubscribe = initDensityStore();

    assert.strictEqual(density.get(), "comfortable");
  });

  test("initializes from localStorage if set", () => {
    // Set localStorage value
    localStorage.setItem("display-density", "compact");

    // Initialize the store
    unsubscribe = initDensityStore();

    assert.strictEqual(density.get(), "compact");
  });

  test("ignores invalid localStorage values", () => {
    // Set invalid localStorage value
    localStorage.setItem("display-density", "invalid");

    // Initialize the store
    unsubscribe = initDensityStore();

    // Should default to comfortable
    assert.strictEqual(density.get(), "comfortable");
  });

  test("updates localStorage when density changes", () => {
    // Initialize the store
    unsubscribe = initDensityStore();

    // Change density to compact
    density.set("compact");

    // Check localStorage was updated
    assert.strictEqual(localStorage.getItem("display-density"), "compact");

    // Change density back to comfortable
    density.set("comfortable");

    // Check localStorage was updated
    assert.strictEqual(localStorage.getItem("display-density"), "comfortable");
  });

  test("notifies subscribers when density changes", () => {
    // Initialize the store
    unsubscribe = initDensityStore();

    let changeCount = 0;
    let lastValue: "comfortable" | "compact" = "comfortable";

    const sub = density.subscribe((value) => {
      changeCount++;
      lastValue = value;
    });

    // Change the value
    density.set("compact");
    assert.strictEqual(changeCount, 1);
    assert.strictEqual(lastValue, "compact");

    // Change the value again
    density.set("comfortable");
    assert.strictEqual(changeCount, 2);
    assert.strictEqual(lastValue, "comfortable");

    sub();
  });
});
