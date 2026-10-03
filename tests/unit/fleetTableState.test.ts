import test from "node:test";
import assert from "node:assert/strict";
import {
  fleetTableState,
  fleetEmptyCopy,
  type FleetTableState,
} from "../../lib/guard/fleetTableState.ts";

/**
 * Empty-state contract for the fleet table (upstream issue #32): three
 * situations that all render an "empty" tbody are distinct states with
 * distinct copy and recovery paths. Cause-inventory as tests.
 */

test("fleetTableState trichotomy", async (t) => {
  await t.test("pending (loading, registry not yet read) → loading", () => {
    const state = fleetTableState({ loading: true, registryCount: 0, filteredCount: 0 });
    assert.equal(state.kind, "loading");
  });

  await t.test("registry-empty (zero guards saved, not loading) → registry-empty", () => {
    const state = fleetTableState({ loading: false, registryCount: 0, filteredCount: 0 });
    assert.equal(state.kind, "registry-empty");
  });

  await t.test("filters exclude every row → filter-empty (never registry-empty)", () => {
    const state = fleetTableState({ loading: false, registryCount: 3, filteredCount: 0 });
    assert.equal(state.kind, "filter-empty");
  });

  await t.test("rows present → rows (loading flag alone cannot mask rows)", () => {
    const state = fleetTableState({ loading: true, registryCount: 2, filteredCount: 2 });
    assert.equal(state.kind, "rows");
  });
});

test("every non-rows state carries copy and a recovery path", async (t) => {
  await t.test("filter-empty copy names the fix: clear the filters", () => {
    const copy = fleetEmptyCopy({ kind: "filter-empty" })!;
    assert.match(copy.title, /[Nn]o guards match/);
    assert.match(copy.hint, /lear/); // recovery says clear
  });

  await t.test("registry-empty copy points at the add-flow (Configure page)", () => {
    const copy = fleetEmptyCopy({ kind: "registry-empty" })!;
    assert.match(copy.hint, /Configure/);
  });

  await t.test("loading copy is pending phrasing, not an empty claim", () => {
    const copy = fleetEmptyCopy({ kind: "loading" })!;
    assert.match(copy.title, /[Ll]oading/);
  });

  await t.test("rows state has no empty copy (must never render one)", () => {
    const state: FleetTableState = { kind: "rows" };
    assert.equal(fleetEmptyCopy(state), null);
  });
});
