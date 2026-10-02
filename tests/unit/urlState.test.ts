import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  URL_TABS,
  decodeUrlState,
  encodeUrlState,
  mergeUrlState,
  routeForTab,
  tabForPathname,
  writeUrlState,
  type UrlState,
} from "../../lib/guard/urlState.ts";

/**
 * Bidirectional coverage for the shareable-view codec (issue #132): every
 * parameter encodes to the documented clean URL, decodes back to the same
 * state, and refuses malformed or unsafe input instead of adopting it.
 *
 * The guard fixtures are real testnet addresses already pinned elsewhere in
 * the repo (`PHASE1_ARTIFACT.guard` in `lib/guard/network.ts`), so a passing
 * test proves the validator accepts exactly what the console itself uses.
 */
const GUARD_A = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const GUARD_B = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

describe("encodeUrlState", () => {
  test("renders the issue's example URL verbatim", () => {
    const encoded = encodeUrlState({
      guard: GUARD_A,
      network: "testnet",
      tab: "telemetry",
      filter: "blocked",
    });
    assert.equal(encoded, `guard=${GUARD_A}&network=testnet&tab=telemetry&filter=blocked`);
  });

  test("an empty state is an empty string, not a bare '?'", () => {
    assert.equal(encodeUrlState({}), "");
  });

  test("the default verdict (`all`) is dropped for a clean URL", () => {
    assert.equal(encodeUrlState({ filter: "all" }), "");
    assert.equal(
      encodeUrlState({ tab: "console", filter: "allowed" }),
      "tab=console&filter=allowed",
    );
  });

  test("parameters appear in canonical order: guard, network, tab, filter", () => {
    const encoded = encodeUrlState({
      filter: "blocked",
      tab: "console",
      network: "testnet",
      guard: GUARD_B,
    });
    assert.equal(encoded, `guard=${GUARD_B}&network=testnet&tab=console&filter=blocked`);
  });

  test("invalid values are dropped rather than rendered", () => {
    assert.equal(
      encodeUrlState({
        guard: "not-an-address",
        network: "mainnet",
        tab: "wat" as unknown as UrlState["tab"],
        filter: "blockedish" as unknown as UrlState["filter"],
      }),
      "",
    );
  });
});

describe("decodeUrlState", () => {
  test("decodes the issue's example URL back to the same state", () => {
    const state = decodeUrlState(`?guard=${GUARD_A}&network=testnet&tab=telemetry&filter=blocked`);
    assert.deepEqual(state, {
      guard: GUARD_A,
      network: "testnet",
      tab: "telemetry",
      filter: "blocked",
    });
  });

  test("accepts a leading '?', a bare query, and an empty search", () => {
    assert.deepEqual(decodeUrlState(`guard=${GUARD_A}`), { guard: GUARD_A });
    assert.deepEqual(decodeUrlState(""), {});
    assert.deepEqual(decodeUrlState("?"), {});
  });

  test("normalises case and whitespace on the enum parameters", () => {
    const state = decodeUrlState("?network=TESTNET&tab=Telemetry&filter=%20BLOCKED%20");
    assert.deepEqual(state, { network: "testnet", tab: "telemetry", filter: "blocked" });
  });

  test("rejects malformed or unsafe guard addresses", () => {
    const malformed = [
      "not-an-address",
      GUARD_A.slice(0, 55), // one character short
      `${GUARD_A}X`, // one character long
      GUARD_A.toLowerCase(), // wrong case for base32
      GUARD_A.replace(/^C/, "G"), // an account address, not a contract
      `${GUARD_A}<script>alert(1)</script>`, // injection attempt
      "../../../etc/passwd", // path traversal in a parameter
      "CA3D%22%3E%3Cimg%20src=x%3E", // encoded markup
      "",
      "   ",
    ];
    for (const guard of malformed) {
      assert.deepEqual(decodeUrlState(`?guard=${encodeURIComponent(guard)}`), {}, `guard=${guard}`);
    }
  });

  test("rejects unknown network, tab and filter values", () => {
    assert.deepEqual(decodeUrlState("?network=mainnet"), {});
    assert.deepEqual(decodeUrlState("?network=testnet2"), {});
    assert.deepEqual(decodeUrlState("?tab=telemetry%20feed"), {});
    assert.deepEqual(decodeUrlState("?tab=<script>"), {});
    assert.deepEqual(decodeUrlState("?filter=blockedish"), {});
    assert.deepEqual(decodeUrlState("?filter=%22blocked%22"), {});
  });

  test("reads each parameter independently — one bad value does not discard the rest", () => {
    const state = decodeUrlState(`?guard=junk&network=testnet&tab=bogus&filter=blocked`);
    assert.deepEqual(state, { network: "testnet", filter: "blocked" });
  });

  test("accepts `filter=all` as an explicit statement of the default", () => {
    assert.deepEqual(decodeUrlState("?filter=all"), { filter: "all" });
  });

  test("ignores parameters this module does not own", () => {
    assert.deepEqual(decodeUrlState("?demo=true&utm_source=chat&tab=fleet"), { tab: "fleet" });
  });
});

describe("encode → decode round trips (bidirectional)", () => {
  test("every tab in the vocabulary survives the trip", () => {
    for (const tab of URL_TABS) {
      const state = { tab };
      assert.deepEqual(decodeUrlState(encodeUrlState(state)), state, `tab=${tab}`);
    }
  });

  test("guard, network and each non-default filter survive the trip", () => {
    const states: UrlState[] = [
      { guard: GUARD_A },
      { guard: GUARD_B },
      { network: "testnet" },
      { filter: "allowed" },
      { filter: "blocked" },
      { guard: GUARD_A, network: "testnet", tab: "console" },
      { guard: GUARD_B, network: "testnet", tab: "telemetry", filter: "blocked" },
      { guard: GUARD_A, tab: "fleet", filter: "allowed" },
    ];
    for (const state of states) {
      assert.deepEqual(decodeUrlState(encodeUrlState(state)), state, JSON.stringify(state));
    }
  });

  test("encode ∘ decode is idempotent on any (even hostile) search string", () => {
    const searches = [
      `?guard=${GUARD_A}&network=testnet&tab=telemetry&filter=blocked`,
      "?guard=%3Cscript%3E&tab=bogus&network=mainnet&filter=<b>&demo=true",
      "?demo=true",
      "",
      "?tab=panic&network=TESTNET",
    ];
    for (const search of searches) {
      const once = encodeUrlState(decodeUrlState(search));
      assert.equal(encodeUrlState(decodeUrlState(`?${once}`)), once, search);
    }
  });
});

describe("mergeUrlState", () => {
  test("keeps parameters the module does not own", () => {
    const merged = mergeUrlState("?demo=true&utm_source=chat", { guard: GUARD_A });
    assert.equal(merged, `guard=${GUARD_A}&demo=true&utm_source=chat`);
  });

  test("leaves unmentioned owned parameters at their validated current value", () => {
    const merged = mergeUrlState(`?guard=${GUARD_A}&network=testnet&filter=blocked`, {
      tab: "console",
    });
    assert.equal(merged, `guard=${GUARD_A}&network=testnet&tab=console&filter=blocked`);
  });

  test("cleans a malformed owned parameter that no one mentioned", () => {
    const merged = mergeUrlState("?guard=<script>&network=mainnet&tab=bogus&filter=blocked", {
      tab: "console",
    });
    assert.equal(merged, "tab=console&filter=blocked");
  });

  test("an explicit undefined deletes the parameter", () => {
    const merged = mergeUrlState(`?guard=${GUARD_A}&filter=blocked`, { filter: undefined });
    assert.equal(merged, `guard=${GUARD_A}`);
  });

  test('`filter: "all"` removes the filter (the default never rides along)', () => {
    const merged = mergeUrlState(`?guard=${GUARD_A}&filter=blocked`, { filter: "all" });
    assert.equal(merged, `guard=${GUARD_A}`);
  });

  test("a write of one owner never drops another owner's parameter", () => {
    // The provider writes guard/network/tab; the feed writes filter.
    let search = "?demo=true";
    search = mergeUrlState(search, { guard: GUARD_A, network: "testnet", tab: "console" });
    search = mergeUrlState(search, { filter: "blocked", tab: "telemetry" });
    assert.equal(search, `guard=${GUARD_A}&network=testnet&tab=telemetry&filter=blocked&demo=true`);
    search = mergeUrlState(search, { guard: GUARD_B });
    assert.equal(search, `guard=${GUARD_B}&network=testnet&tab=telemetry&filter=blocked&demo=true`);
  });
});

describe("writeUrlState (the browser binding)", () => {
  /** Install a minimal fake `window`; `location.assign` deliberately absent. */
  function installFakeWindow(href: string) {
    const url = new URL(href);
    const replacedWith: string[] = [];
    let hrefAssignments = 0;
    const location = {
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
      get hash() {
        return url.hash;
      },
      get href() {
        return url.href;
      },
      set href(_value: string) {
        hrefAssignments += 1;
      },
      assign() {
        throw new Error("writeUrlState must never navigate");
      },
    };
    const history = {
      state: { preserved: true },
      replaceState(_state: unknown, _title: string, next: string) {
        replacedWith.push(next);
        const resolved = new URL(next, url);
        url.pathname = resolved.pathname;
        url.search = resolved.search;
        url.hash = resolved.hash;
      },
    };
    const fake = { location, history } as unknown as Window;
    Object.defineProperty(globalThis, "window", {
      value: fake,
      configurable: true,
      writable: true,
    });
    return {
      replacedWith,
      get hrefAssignments() {
        return hrefAssignments;
      },
      get currentHref() {
        return url.href;
      },
      dispose() {
        Reflect.deleteProperty(globalThis, "window");
      },
    };
  }

  test("mirrors state with replaceState only — no reload, no history growth", () => {
    const fake = installFakeWindow("https://guard.example/?demo=true&guard=old#feed");
    try {
      writeUrlState({ guard: GUARD_A, network: "testnet" });
      assert.equal(fake.replacedWith.length, 1);
      assert.equal(fake.hrefAssignments, 0);
      assert.equal(fake.replacedWith[0], `/?guard=${GUARD_A}&network=testnet&demo=true#feed`);
      // The window now reads back what was written (and `?demo=true` survived).
      assert.deepEqual(decodeUrlState(window.location.search), {
        guard: GUARD_A,
        network: "testnet",
      });
      assert.match(window.location.search, /demo=true/);
      assert.equal(window.location.hash, "#feed");
    } finally {
      fake.dispose();
    }
  });

  test("a second write of the same state is a no-op", () => {
    const fake = installFakeWindow("https://guard.example/");
    try {
      writeUrlState({ tab: "console" });
      assert.equal(fake.replacedWith.length, 1);
      writeUrlState({ tab: "console" });
      assert.equal(fake.replacedWith.length, 1);
    } finally {
      fake.dispose();
    }
  });

  test("is a silent no-op during server rendering (no window)", () => {
    Reflect.deleteProperty(globalThis, "window");
    assert.equal(typeof window, "undefined");
    assert.doesNotThrow(() => writeUrlState({ tab: "console" }));
  });
});

describe("tab routing helpers", () => {
  test("tabForPathname maps every screen route, defaulting to console", () => {
    assert.equal(tabForPathname("/"), "console");
    assert.equal(tabForPathname("/fleet"), "fleet");
    assert.equal(tabForPathname("/configure"), "configure");
    assert.equal(tabForPathname("/deploy"), "deploy");
    assert.equal(tabForPathname("/panic"), "panic");
    assert.equal(tabForPathname("/somewhere-else"), "console");
  });

  test("routeForTab inverts tabForPathname for screens and returns null for panels", () => {
    for (const tab of URL_TABS) {
      const route = routeForTab(tab);
      if (route === null) {
        // Panel tabs have no route of their own: they live on the console.
        assert.notEqual(tab, "console");
        continue;
      }
      assert.equal(tabForPathname(route), tab, `tab=${tab}`);
    }
    assert.equal(routeForTab("telemetry"), null);
    assert.equal(routeForTab("fleet"), "/fleet");
  });
});
