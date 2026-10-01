# Telemetry export schema

The telemetry feed's **Export CSV** and **Export JSON** buttons write the feed's
visible events to a file. Both formats share one column schema; this document is
the contract for anything that parses those exports, and
`tests/unit/eventExport.test.ts` syncs the implementation against it.

## Compatibility rule: append-only

**Columns are append-only.** A schema change may _add_ a column at the end of
the list; it must never rename, reorder, or remove an existing column. The
`schema_version` cell lets a script assert which schema it is reading, and a
parser that ignores unknown trailing columns stays compatible with every future
version of this export.

## Columns (in order)

| #   | Column             | Meaning                                                                             | Empty when                                                          |
| --- | ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `schema_version`   | Export schema version — currently `1`.                                              | Never.                                                              |
| 2   | `guard`            | The guard contract id the export was taken from; stamped on every row.              | Never.                                                              |
| 3   | `topic`            | The event's topic symbol, e.g. `event_auth_checked`.                                | Never.                                                              |
| 4   | `kind`             | Classified event kind (`auth_checked`, `heartbeat`, `frozen`, …).                   | Never.                                                              |
| 5   | `source`           | Where the event was observed: `ledger` (committed) or `diagnostic` (pre-broadcast). | Never.                                                              |
| 6   | `decision`         | `allowed` or `blocked` for auth-check events.                                       | Non-auth events carry no decision.                                  |
| 7   | `reason`           | The raw contract block reason symbol, e.g. `per_tx_cap_exceeded`.                   | Allowed decisions and non-auth events.                              |
| 8   | `reason_label`     | The SDK's human explanation of `reason` (via `explainReason`).                      | Same rows as `reason`.                                              |
| 9   | `ledger`           | Ledger sequence the event was committed in.                                         | Diagnostic events — a blocked transaction never reaches the ledger. |
| 10  | `ledger_closed_at` | ISO-8601 close time of that ledger.                                                 | Diagnostic events.                                                  |
| 11  | `transaction_hash` | Hash of the committed transaction.                                                  | Diagnostic events.                                                  |

### Practical ceiling

The feed keeps the **250 most recent events** (newest first), so an export
contains at most 250 data rows and always reflects what the operator can see.
Export earlier if you need more history; the feed is a console, not an archive.

## Cell conventions

- **Every cell is a string.** Ledger sequences and the schema version are
  decimal strings (`"4820001"`), timestamps are ISO-8601 strings — nothing is
  coerced to a number, so i128 amounts and ISO precision survive round-trips.
- **CSV** follows RFC 4180: cells containing commas, quotes or newlines are
  quoted, embedded quotes are doubled. The file is **BOM-prefixed** (U+FEFF /
  `EF BB BF`) so Excel opens it as UTF-8. The first row is the column list
  verbatim; data rows follow in feed order.
- **JSON** is one object: `schemaVersion`, then `columns` (the same list), then
  `guard`, then `rows` — each row an object keyed by column name, values
  stringified exactly like the CSV cells.
- **Filename**: `guard-events-<guard[:8]>-<YYYY-MM-DD>-<rowCount>.<ext>` — UTC
  ISO date, deterministic for a given day and row count, so two exports of the
  same feed on the same day differ only when the row count differs.
