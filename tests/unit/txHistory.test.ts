import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TX_HISTORY_LIMIT,
  TX_HISTORY_STORAGE_KEY,
  filterTxHistory,
  loadTxHistory,
  paginateTxHistory,
  recordTx,
  subscribeTxHistory,
  txHistoryToCsv,
  type StorageLike,
  type TxHistoryEntry,
} from "../../lib/guard/txHistory.ts";

function fakeStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function entry(overrides: Partial<TxHistoryEntry> = {}): TxHistoryEntry {
  return {
    hash: `hash-${Math.random().toString(16).slice(2)}`,
    operation: "set_policy",
    status: "confirmed",
    feeStroops: "210",
    recordedAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

test("a recorded transaction is persisted and reloaded newest first", () => {
  const storage = fakeStorage();
  recordTx({ hash: "h1", operation: "freeze", status: "confirmed", feeStroops: "100" }, storage);
  recordTx({ hash: "h2", operation: "set_policy", status: "failed", feeStroops: null }, storage);

  const loaded = loadTxHistory(storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]?.hash, "h2");
  assert.equal(loaded[1]?.hash, "h1");
  assert.equal(loaded[0]?.status, "failed");
  // feeStroops null survives the round trip as null, not as a missing field.
  assert.equal(loaded[0]?.feeStroops, null);
});

test("recording notifies subscribers so open tables can refresh", () => {
  const storage = fakeStorage();
  let notified = 0;
  const unsubscribe = subscribeTxHistory(() => {
    notified += 1;
  });
  try {
    recordTx({ hash: "h1", operation: "freeze", status: "confirmed", feeStroops: null }, storage);
    assert.equal(notified, 1);
  } finally {
    unsubscribe();
  }
  recordTx({ hash: "h2", operation: "freeze", status: "confirmed", feeStroops: null }, storage);
  assert.equal(notified, 1, "an unsubscribed listener must not be called");
});

test("the history is capped at 200 entries, dropping the oldest", () => {
  const storage = fakeStorage();
  for (let index = 0; index < TX_HISTORY_LIMIT + 5; index += 1) {
    recordTx(
      { hash: `h${index}`, operation: "freeze", status: "confirmed", feeStroops: "100" },
      storage,
    );
  }
  const loaded = loadTxHistory(storage);
  assert.equal(loaded.length, TX_HISTORY_LIMIT);
  // Newest first: the very last record is on top, the very first was dropped.
  assert.equal(loaded[0]?.hash, `h${TX_HISTORY_LIMIT + 4}`);
  assert.equal(
    loaded.some((item) => item.hash === "h0"),
    false,
  );
});

test("re-recording a hash replaces the entry instead of duplicating it", () => {
  const storage = fakeStorage();
  recordTx({ hash: "same", operation: "freeze", status: "failed", feeStroops: "100" }, storage);
  recordTx({ hash: "same", operation: "freeze", status: "confirmed", feeStroops: "100" }, storage);

  const loaded = loadTxHistory(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.status, "confirmed");
});

test("a corrupt or non-array storage payload yields an empty history", () => {
  const storage = fakeStorage();
  storage.setItem(TX_HISTORY_STORAGE_KEY, "{not json");
  assert.deepEqual(loadTxHistory(storage), []);
  storage.setItem(TX_HISTORY_STORAGE_KEY, JSON.stringify({ not: "an array" }));
  assert.deepEqual(loadTxHistory(storage), []);
  // Malformed entries are dropped rather than rendered half-formed.
  storage.setItem(
    TX_HISTORY_STORAGE_KEY,
    JSON.stringify([entry(), { hash: "broken", status: "weird" }]),
  );
  assert.equal(loadTxHistory(storage).length, 1);
});

test("search matches operation, hash and status, case-insensitively", () => {
  const entries = [
    entry({ hash: "AAA111", operation: "freeze", status: "confirmed" }),
    entry({ hash: "BBB222", operation: "set_policy", status: "failed" }),
    entry({ hash: "CCC333", operation: "unfreeze", status: "confirmed" }),
  ];
  assert.equal(filterTxHistory(entries, { query: "FREEZE" }).length, 2);
  assert.equal(filterTxHistory(entries, { query: "bbb" }).length, 1);
  assert.equal(filterTxHistory(entries, { query: "failed" }).length, 1);
  assert.equal(filterTxHistory(entries, { query: "nothing here" }).length, 0);
});

test("date range filtering is inclusive on both ends", () => {
  const entries = [
    entry({ hash: "old", recordedAt: "2026-09-20T23:59:59.000Z" }),
    entry({ hash: "start", recordedAt: "2026-09-21T00:00:00.000Z" }),
    entry({ hash: "mid", recordedAt: "2026-09-22T12:00:00.000Z" }),
    entry({ hash: "end", recordedAt: "2026-09-23T23:59:59.000Z" }),
    entry({ hash: "future", recordedAt: "2026-09-24T00:00:00.000Z" }),
  ];
  const inRange = filterTxHistory(entries, { from: "2026-09-21", to: "2026-09-23" });
  assert.deepEqual(
    inRange.map((item) => item.hash),
    ["start", "mid", "end"],
  );
  // An open-ended range filters only on the closed side.
  assert.equal(filterTxHistory(entries, { from: "2026-09-23" }).length, 2);
  assert.equal(filterTxHistory(entries, { to: "2026-09-21" }).length, 2);
});

test("query and date filters combine, and no filters leaves the list untouched", () => {
  const entries = [
    entry({ hash: "keep", operation: "freeze", recordedAt: "2026-09-22T10:00:00.000Z" }),
    entry({ hash: "wrong-day", operation: "freeze", recordedAt: "2026-09-10T10:00:00.000Z" }),
    entry({ hash: "wrong-op", operation: "revoke_policy", recordedAt: "2026-09-22T10:00:00.000Z" }),
  ];
  const filtered = filterTxHistory(entries, { query: "freeze", from: "2026-09-21" });
  assert.deepEqual(
    filtered.map((item) => item.hash),
    ["keep"],
  );
  assert.equal(filterTxHistory(entries, {}), entries);
  assert.equal(filterTxHistory(entries, { query: "  ", from: "", to: "" }), entries);
});

test("pagination slices pages and clamps out-of-range page numbers", () => {
  const entries = Array.from({ length: 25 }, (_, index) => entry({ hash: `h${index}` }));

  const first = paginateTxHistory(entries, 1, 10);
  assert.equal(first.rows.length, 10);
  assert.equal(first.pages, 3);
  assert.equal(first.total, 25);
  assert.equal(first.rows[0]?.hash, "h0");

  const last = paginateTxHistory(entries, 3, 10);
  assert.equal(last.rows.length, 5);
  assert.equal(last.rows[4]?.hash, "h24");

  // Below one and past the end both clamp instead of returning nothing.
  assert.equal(paginateTxHistory(entries, 0, 10).page, 1);
  assert.equal(paginateTxHistory(entries, 99, 10).page, 3);
  assert.equal(paginateTxHistory(entries, Number.NaN, 10).page, 1);
});

test("an empty list paginates to a single empty page", () => {
  const page = paginateTxHistory([], 1, 10);
  assert.deepEqual(page, { rows: [], page: 1, pages: 1, total: 0 });
});

test("CSV export has a fixed header and one quoted row per entry", () => {
  const entries = [
    entry({ hash: "h1", operation: "set_policy", feeStroops: "310" }),
    entry({
      hash: "h2",
      operation: 'odd "operation"',
      status: "failed",
      feeStroops: null,
      recordedAt: "2026-09-24T11:00:00.000Z",
    }),
  ];
  const csv = txHistoryToCsv(entries);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "timestamp,operation,status,tx_hash,fee_stroops");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '"2026-09-24T10:00:00.000Z","set_policy","confirmed","h1","310"');
  // Embedded quotes are doubled per RFC 4180, and a null fee exports empty.
  assert.equal(lines[2], '"2026-09-24T11:00:00.000Z","odd ""operation""","failed","h2",""');
});
