/**
 * Carrying "which guard am I looking at" across the console → configure hop.
 *
 * Both pages mount their own `GuardProvider`, so a plain `/configure` link lands
 * the operator on a freshly-mounted provider that falls back to the first known
 * instance — silently showing them a *different account's* state. The guard
 * address therefore rides in the query string, and the provider on the other
 * side adopts it.
 *
 * The network needs no threading: `NETWORK` is a build-time constant (one
 * passphrase, one RPC endpoint) and the connected wallet is checked against it
 * on every connect, so there is no second network for a link to disagree with.
 */

import { looksLikeContractAddress } from "./instance.ts";

/** The query parameter that carries the guard address. */
export const GUARD_QUERY_PARAM = "guard";

/** The link the default-deny banner's call to action points at. */
export function configureHref(guard: string): string {
  return `/configure?${GUARD_QUERY_PARAM}=${encodeURIComponent(guard)}`;
}

/** A guard address carried by a URL, or `null` when there is not a usable one. */
export function guardFromSearch(search: string): string | null {
  const requested = new URLSearchParams(search).get(GUARD_QUERY_PARAM)?.trim();
  if (!requested || !looksLikeContractAddress(requested)) return null;
  return requested;
}

export interface GuardDeepLink {
  /** The guard to select. */
  guard: string;
  /**
   * True when the address is not in the instance registry, so the provider has
   * to add it — otherwise the selector would hold a value no option matches and
   * the page would render a guard the operator cannot see the name of.
   */
  addToRegistry: boolean;
}

/**
 * Which guard a page load should select, and whether the registry needs to grow.
 *
 * `null` means "leave the selection alone": no `?guard=` was present, it was not
 * a contract address, or it is already the current selection.
 */
export function resolveGuardFromSearch(params: {
  search: string;
  registry: readonly { guard: string }[];
  current: string;
}): GuardDeepLink | null {
  const requested = guardFromSearch(params.search);
  if (!requested || requested === params.current) return null;
  return {
    guard: requested,
    addToRegistry: !params.registry.some((instance) => instance.guard === requested),
  };
}
