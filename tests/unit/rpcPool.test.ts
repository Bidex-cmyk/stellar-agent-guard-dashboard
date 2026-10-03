import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { RpcPool } from "../../lib/guard/rpcPool.ts";

describe("RpcPool", () => {
  it("initialises with the primary URL as the active endpoint", () => {
    const pool = new RpcPool("http://primary", ["http://fallback"]);
    assert.equal(pool.currentUrl, "http://primary");
  });

  it("falls over to the fallback URL after 3 consecutive network failures", async () => {
    const pool = new RpcPool("http://primary", ["http://fallback"]);

    // Stub globalThis.fetch so the pool never hits the network
    const stubFetch = mock.fn(async () => {
      throw new Error("Network error");
    });
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch as unknown as typeof fetch;

    try {
      for (let i = 0; i < 3; i++) {
        try {
          await pool.fetch("/test");
        } catch {
          // expected
        }
      }
    } finally {
      globalThis.fetch = orig;
    }

    assert.equal(pool.currentUrl, "http://fallback");
  });

  it("exposes rtt as a non-negative number after a successful request", async () => {
    const pool = new RpcPool("http://primary", []);
    const mockResponse = {
      status: 200,
      ok: true,
    } as Response;

    const stubFetch = mock.fn(async () => mockResponse);
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch as unknown as typeof fetch;

    try {
      await pool.fetch("/health");
    } finally {
      globalThis.fetch = orig;
    }

    assert.ok(pool.rtt >= 0, "rtt should be >= 0 after a successful fetch");
  });
});
