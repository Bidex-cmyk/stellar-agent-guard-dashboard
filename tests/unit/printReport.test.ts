import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePrintReport } from "../../lib/guard/printReport.ts";

test("compilePrintReport extracts correct fields from snapshot", () => {
  const mockSnapshot = {
    guard: "CABC123...",
    fetchedAt: "2026-09-25",
    status: {
      ok: true,
      value: {
        heartbeat_expired: false,
        admin_frozen: false,
        has_policy: true,
        last_heartbeat: 0n,
      },
    },
    policy: {
      ok: true,
      value: {
        per_tx_cap: 100n,
        window_cap: 1000n,
        window_secs: 60n,
        assets: ["A1"],
        recipients: ["R1"],
        protocols: [],
        paused: false,
        active_from: 0n,
        active_until: 0n,
        allow_any_recipient: false,
      },
    },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: { reportedWasmHash: "hash123", fetchedSha256: "hash123", bytes: 1000 },
    },
  } as any;

  const report = compilePrintReport(mockSnapshot, "Testnet", "GADMIN...");

  assert.equal(report.contractId, "CABC123...");
  assert.equal(report.bytecodeHash, "hash123");
  assert.equal(report.adminKey, "GADMIN...");
  assert.equal(report.network, "Testnet");
  assert.equal(report.dmsStatus, "OK");
  assert.equal(report.allowlists.assets[0], "A1");
});
