import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { fetchTokenMetadata } from "../../lib/guard/tokenMetadata.ts";

const CONTRACT = `C${"A".repeat(55)}`;
const OTHER = `C${"B".repeat(55)}`;

function jsonResponse(result: string): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // fetchTokenMetadata memoizes per contract id; start each test from scratch.
  globalThis.fetch = (async () => {
    throw new Error("fetch not stubbed");
  }) as unknown as typeof fetch;
});

test("caches results for the same contractId", async () => {
  let calls = 0;
  const methods: string[] = [];
  // The module POSTs { contractId, method, args } per metadata field; answer
  // each method distinctly so decimals/symbol/name parsing is really exercised.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    const method = body.method ?? "";
    methods.push(method);
    const value = method === "decimals" ? "6" : method === "symbol" ? "USDC" : "USD Coin";
    return jsonResponse(value);
  }) as unknown as typeof fetch;

  const res1 = await fetchTokenMetadata("http://rpc", CONTRACT);
  const res2 = await fetchTokenMetadata("http://rpc", CONTRACT);

  // One memoized entry serves the second read.
  assert.equal(res1, res2);
  assert.equal(calls, 3);
  assert.deepEqual([...methods].sort(), ["decimals", "name", "symbol"]);

  // Each field decoded from its own RPC response.
  assert.equal(res1.decimals, 6);
  assert.equal(res1.symbol, "USDC");
  assert.equal(res1.name, "USD Coin");
});

test("returns warning for invalid (non-SAC) contract address", async () => {
  const res = await fetchTokenMetadata("http://rpc", "INVALID_CONTRACT");
  assert.ok(res.warning);
  assert.match(res.warning, /does not appear to be a valid SAC address/);
});

test("returns fallback with warning when RPC call fails", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network error");
  }) as unknown as typeof fetch;

  const res = await fetchTokenMetadata("http://rpc", OTHER);
  assert.ok(res.warning);
  assert.match(res.warning, /Failed to query token metadata/);
});
