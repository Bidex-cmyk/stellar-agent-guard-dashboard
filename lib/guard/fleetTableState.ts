/**
 * Fleet table state machine (upstream issue #32).
 *
 * The fleet table's body must never be a bare "0 rows" box: three different
 * situations look identical inside an empty `<tbody>` but demand different
 * copy and different recovery paths. Classifying them is pure logic, so it
 * lives here with the rest of the tested surface.
 *
 *   - `loading`   — first fetch still in flight; render the pending skeleton.
 *   - `registry-empty` — no guards saved at all; the fix is adding one, so the
 *     empty state points at the Configure page (recovery link).
 *   - `filter-empty`   — guards exist but the search/filters exclude every
 *     row; the fix is clearing the filters, so the empty state carries a
 *     clear button (the incident-class rule: a filter that hides everything
 *     must always offer a way back).
 *   - `rows`      — at least one row to render.
 *
 * `registryEmpty` (not just `rows.length === 0`) decides between the two
 * empties because the recovery paths differ.
 */
export type FleetTableState =
  { kind: "loading" } | { kind: "registry-empty" } | { kind: "filter-empty" } | { kind: "rows" };

export function fleetTableState(input: {
  loading: boolean;
  registryCount: number;
  filteredCount: number;
}): FleetTableState {
  if (input.loading && input.registryCount === 0) return { kind: "loading" };
  if (input.registryCount === 0) return { kind: "registry-empty" };
  if (input.filteredCount === 0) return { kind: "filter-empty" };
  return { kind: "rows" };
}

/** Copy for each non-rows state, single-sourced so tests can pin it. */
export function fleetEmptyCopy(state: FleetTableState): { title: string; hint: string } | null {
  switch (state.kind) {
    case "loading":
      return {
        title: "Loading fleet data…",
        hint: "Reading each registered guard from the chain.",
      };
    case "registry-empty":
      return {
        title: "No guards in your registry yet",
        hint: "Add one from the Configure page to see it here.",
      };
    case "filter-empty":
      return {
        title: "No guards match the current search or filters",
        hint: "Clear the search or set the filters back to All.",
      };
    default:
      return null;
  }
}
