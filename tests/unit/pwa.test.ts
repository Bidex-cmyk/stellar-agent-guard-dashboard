import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  PWA_MANIFEST_PATH,
  PWA_OFFLINE_PATH,
  PWA_THEME_COLOR,
  SERVICE_WORKER_PATH,
} from "../../lib/guard/pwa.ts";

interface ManifestIcon {
  src: string;
  type: string;
  sizes: string;
  purpose?: string;
}

interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as WebAppManifest;

describe("web app manifest", () => {
  it("is served from the path the application and its metadata agree on", () => {
    assert.equal(PWA_MANIFEST_PATH, "/manifest.json");
    assert.equal(existsSync(`public${PWA_MANIFEST_PATH}`), true);
    assert.equal(existsSync(`public${SERVICE_WORKER_PATH}`), true);
  });

  it("declares the installed app's identity", () => {
    assert.match(manifest.name, /stellar agent guard/i);
    assert.ok(manifest.short_name.length > 0 && manifest.short_name.length <= 12);
    assert.ok(manifest.description.length > 0);
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.scope, "/");
    assert.equal(manifest.id, "/");
    assert.equal(manifest.display, "standalone");
  });

  it("uses the console's own dark palette for the browser chrome", () => {
    assert.equal(manifest.theme_color, PWA_THEME_COLOR);
    assert.equal(manifest.background_color, PWA_THEME_COLOR);
    // The manifest colours must not drift from the stylesheet's page background.
    const css = readFileSync("app/globals.css", "utf8");
    assert.match(
      css,
      new RegExp(`--bg:\\s*${PWA_THEME_COLOR}`, "i"),
      "manifest theme colour must match the console's --bg token",
    );
  });

  it("ships a regular and a maskable icon, and both files exist", () => {
    assert.ok(
      manifest.icons.length >= 2,
      "an installed app needs at least a regular and a maskable icon",
    );
    const purposes = manifest.icons.map((icon) => icon.purpose ?? "any");
    assert.ok(purposes.includes("any"), "a purpose=any icon is required");
    assert.ok(purposes.includes("maskable"), "a purpose=maskable icon is required");

    for (const icon of manifest.icons) {
      assert.match(icon.src, /^\//, `${icon.src} must be an absolute public path`);
      assert.equal(icon.type, "image/svg+xml");
      // `sizes: any` is the correct declaration for a resolution-independent SVG.
      assert.equal(icon.sizes, "any");
      assert.equal(existsSync(`public${icon.src}`), true, `${icon.src} must exist under public/`);
    }
  });
});

// ── Service worker ─────────────────────────────────────────────────────────

const ORIGIN = "https://dashboard.test";

interface FetchRequestLike {
  url: string;
  method: string;
  mode: string;
}

interface ServiceWorkerEvent {
  request?: FetchRequestLike;
  respondWith?(value: Promise<Response>): void;
  waitUntil?(value: Promise<unknown>): void;
}

type SwListener = (event: ServiceWorkerEvent) => void;

interface FetchOutcome {
  respondWithCalled: boolean;
  response: Response | undefined;
}

/**
 * Runs `public/sw.js` in a sandbox with just enough of the worker global scope
 * to observe what it does: the `caches` and `fetch` calls it makes, and whether
 * it took ownership of a request by calling `respondWith`.
 *
 * Testing the real file (rather than a copy of its rules) is what makes the
 * bypass assertions meaningful — a stale-worker regression has to fail here.
 */
function createServiceWorkerHarness() {
  const listeners: Record<string, SwListener[]> = { install: [], activate: [], fetch: [] };
  const storage = new Map<string, Response>();
  const putUrls: string[] = [];
  const matchUrls: string[] = [];
  const precached: string[] = [];
  const fetchedUrls: string[] = [];
  const openedCaches = new Set<string>();
  let networkDown = false;

  const absolute = (input: string): string => {
    try {
      return new URL(input, ORIGIN).href;
    } catch {
      return input;
    }
  };

  const keyOf = (input: unknown): string => {
    if (typeof input === "string") return absolute(input);
    if (typeof input === "object" && input !== null && "url" in input) {
      return String((input as { url: unknown }).url);
    }
    return String(input);
  };

  const cache = {
    async addAll(urls: string[]): Promise<void> {
      for (const url of urls) {
        precached.push(url);
        storage.set(absolute(url), new Response("precached", { status: 200 }));
      }
    },
    async match(request: unknown): Promise<Response | undefined> {
      matchUrls.push(keyOf(request));
      return storage.get(keyOf(request));
    },
    async put(request: unknown, response: Response): Promise<void> {
      putUrls.push(keyOf(request));
      storage.set(keyOf(request), response);
    },
  };

  const caches = {
    async open(name: string): Promise<typeof cache> {
      openedCaches.add(name);
      return cache;
    },
    async keys(): Promise<string[]> {
      return [...openedCaches];
    },
    async delete(): Promise<boolean> {
      return true;
    },
  };

  const fakeFetch = async (request: unknown): Promise<Response> => {
    fetchedUrls.push(keyOf(request));
    if (networkDown) throw new Error("offline");
    return new Response("network", { status: 200 });
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, listener: SwListener): void {
      (listeners[type] ??= []).push(listener);
    },
    async skipWaiting(): Promise<void> {},
    clients: { async claim(): Promise<void> {} },
  };

  new vm.Script(readFileSync("public/sw.js", "utf8"), { filename: "public/sw.js" }).runInNewContext(
    {
      self,
      caches,
      fetch: fakeFetch,
      Response,
      URL,
      console,
    },
  );

  async function install(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const event: ServiceWorkerEvent = {
      waitUntil(value) {
        pending.push(Promise.resolve(value));
      },
    };
    for (const listener of listeners.install ?? []) listener(event);
    await Promise.all(pending);
  }

  async function dispatchFetch(
    url: string,
    options: { mode?: string; method?: string } = {},
  ): Promise<FetchOutcome> {
    const request: FetchRequestLike = {
      url: absolute(url),
      method: options.method ?? "GET",
      mode: options.mode ?? "no-cors",
    };
    let respondWithCalled = false;
    let responsePromise: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    const event: ServiceWorkerEvent = {
      request,
      respondWith(value) {
        respondWithCalled = true;
        responsePromise = value;
      },
      waitUntil(value) {
        pending.push(Promise.resolve(value));
      },
    };
    for (const listener of listeners.fetch ?? []) listener(event);
    const response = responsePromise ? await responsePromise : undefined;
    // Let any background revalidation the worker scheduled settle too.
    await Promise.allSettled(pending);
    return { respondWithCalled, response };
  }

  return {
    precached,
    putUrls,
    matchUrls,
    fetchedUrls,
    install,
    dispatchFetch,
    setNetworkDown(down: boolean): void {
      networkDown = down;
    },
    resetCounters(): void {
      putUrls.length = 0;
      matchUrls.length = 0;
      fetchedUrls.length = 0;
    },
  };
}

/** The endpoints that must never be served from, or written to, a cache. */
const NETWORK_ONLY_URLS = [
  "https://soroban-testnet.stellar.org/soroban/rpc",
  "https://soroban-testnet.stellar.org/",
  `${ORIGIN}/soroban/rpc`,
  "https://horizon-testnet.stellar.org/accounts/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH",
  `${ORIGIN}/horizon/accounts/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH`,
];

describe("service worker cache-bypassing rules", () => {
  it("precaches the static shell on install, including the offline document", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    assert.ok(sw.precached.includes("/"));
    assert.ok(sw.precached.includes(PWA_MANIFEST_PATH));
    assert.ok(sw.precached.includes(PWA_OFFLINE_PATH));
    assert.ok(sw.precached.includes("/icons/icon.svg"));
    assert.ok(sw.precached.includes("/icons/icon-maskable.svg"));
  });

  it("hard-bypasses every Soroban RPC and Horizon request", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    for (const url of NETWORK_ONLY_URLS) {
      sw.resetCounters();
      const outcome = await sw.dispatchFetch(url, { mode: "cors" });
      assert.equal(
        outcome.respondWithCalled,
        false,
        `${url} must bypass the worker so the browser's own network path handles it`,
      );
      assert.deepEqual(sw.putUrls, [], `${url} must never be written to a cache`);
      assert.deepEqual(sw.matchUrls, [], `${url} must never be read from a cache`);
      assert.deepEqual(sw.fetchedUrls, [], `${url} must not even be proxied through the worker`);
    }
  });

  it("caches same-origin static assets", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    sw.resetCounters();

    const outcome = await sw.dispatchFetch("/icons/icon.svg");
    assert.equal(outcome.respondWithCalled, true, "static assets are served by the worker");
    assert.equal(outcome.response?.status, 200);
    assert.deepEqual(
      sw.putUrls,
      [`${ORIGIN}/icons/icon.svg`],
      "the asset is written to the static cache",
    );
  });

  it("serves a navigation from the network, and the cached shell when the network is gone", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();

    sw.resetCounters();
    const online = await sw.dispatchFetch("/", { mode: "navigate" });
    assert.equal(online.respondWithCalled, true);
    assert.equal(online.response?.status, 200);
    assert.deepEqual(sw.fetchedUrls, [`${ORIGIN}/`]);

    sw.setNetworkDown(true);
    const offline = await sw.dispatchFetch("/configure", { mode: "navigate" });
    assert.equal(offline.respondWithCalled, true, "an offline navigation still gets a response");
    assert.equal(offline.response?.status, 200, "the precached shell answers it");
  });

  it("never takes over a write, and never caches one", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    sw.resetCounters();

    const outcome = await sw.dispatchFetch("/", { method: "POST", mode: "cors" });
    assert.equal(outcome.respondWithCalled, false);
    assert.deepEqual(sw.putUrls, []);
    assert.deepEqual(sw.fetchedUrls, []);
  });

  it("returns a network error rather than throwing when offline with an empty cache", async () => {
    const sw = createServiceWorkerHarness();
    sw.setNetworkDown(true);

    const outcome = await sw.dispatchFetch("/configure", { mode: "navigate" });
    assert.equal(outcome.respondWithCalled, true);
    assert.equal(outcome.response?.status, 0, "a `Response.error()` is the graceful empty answer");
  });
});

// ── Wiring ─────────────────────────────────────────────────────────────────

describe("PWA wiring", () => {
  it("points the document at the manifest, tints the chrome, and mounts the registrar", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    assert.match(layout, /manifest:\s*PWA_MANIFEST_PATH/);
    assert.match(layout, /themeColor:\s*PWA_THEME_COLOR/);
    assert.match(layout, /<PwaRegistrar\s*\/>/);
  });

  it("registers the service worker from the canonical path", () => {
    const registrar = readFileSync("components/PwaRegistrar.tsx", "utf8");
    assert.match(registrar, /navigator\.serviceWorker[\s\S]*?\.register\(SERVICE_WORKER_PATH\)/);
  });

  it("serves the worker and manifest with the types and revalidation they need", () => {
    const config = readFileSync("next.config.ts", "utf8");
    assert.match(config, /source:\s*"\/sw\.js"/);
    assert.match(config, /Service-Worker-Allowed/);
    assert.match(config, /application\/manifest\+json/);
  });
});
