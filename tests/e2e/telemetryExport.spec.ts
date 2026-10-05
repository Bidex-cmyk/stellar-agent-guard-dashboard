/**
 * Telemetry filtering and export, end to end (issue #113).
 *
 * The feed is fed 50 mixed events through the mocked Soroban RPC — 35 approved
 * transfers, 10 blocked cap-exceeded decisions, 5 heartbeats — and every filter
 * control is exercised against the rendered rows before each export is
 * intercepted and parsed. The point of parsing the downloads is that a CSV or
 * NDJSON file is a published format: the test asserts the column header, one
 * row per visible event, and that the data in the file is the data on screen —
 * never a hidden superset of it.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { explainReason, GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import { installSorobanRpcMock } from "./sorobanRpcMock.ts";
import { installFreighterMock } from "./walletMock.ts";
import {
  MIXED_FEED_BLOCK_REASON,
  MIXED_FEED_COUNTS,
  MIXED_FEED_TOTAL,
  mixedTelemetryEvents,
} from "../mocks/eventFixtures.ts";
import { EVENT_EXPORT_COLUMNS } from "../../lib/guard/eventExport.ts";

/** The console's default guard — the one the feed tails in this test. */
const WATCHED_GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/**
 * Scope every assertion to the feed panel, never to another `table.events`.
 *
 * The dashboard grid (#149) wraps each panel in a `<section class="panel">`
 * that carries the same "Telemetry" title, so this scopes to the feed's own
 * `<div class="panel">` to stay on the panel whose table this suite asserts.
 */
function feed(page: Page) {
  return page
    .locator("div.panel")
    .filter({ has: page.getByRole("heading", { name: "Telemetry", exact: true }) });
}

/** Trigger an export button inside the feed and return the downloaded file's text. */
async function exportedText(scope: Locator, buttonName: string): Promise<string> {
  const [download] = await Promise.all([
    scope.page().waitForEvent("download"),
    scope.getByRole("button", { name: buttonName }).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFileSync(path!, "utf8");
}

/**
 * A minimal RFC 4180 parser.
 *
 * The `data` column is compact JSON (commas, quotes, and — for real events —
 * the occasional newline inside a body), so a split-on-comma check would pass
 * on the header and silently mangle every row that matters.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test.describe("telemetry feed: filtering and export", () => {
  test("filters the mixed feed and exports exactly what is on screen", async ({ page }) => {
    await installFreighterMock(page);
    const chain = await installSorobanRpcMock(page, { events: mixedTelemetryEvents() });

    await page.goto("/");
    await feed(page).getByRole("button", { name: "Start watching" }).click();

    const rows = feed(page).locator("table.events tbody tr");
    await expect(rows).toHaveCount(MIXED_FEED_TOTAL, { timeout: 30_000 });
    await expect(feed(page)).toContainText(
      `Feed holds the most recent ${MIXED_FEED_TOTAL} event(s)`,
    );

    // Since issue #23 the feed tails *every* registered guard (up to the cap),
    // so the stream is drained once per tailed guard rather than once per tab.
    // The tailed count is read from the panel's own announcement, so the RPC
    // assertion and what the operator is told cannot drift apart: the mock
    // serves each guard the same page, and every row still de-duplicates to one.
    const announcement = feed(page).getByText(/Tailing \d+ guards? simultaneously/);
    await expect(announcement).toBeVisible();
    const tailedCount = Number(
      /Tailing (\d+) guards?/.exec((await announcement.textContent()) ?? "")?.[1],
    );
    assert.ok(tailedCount >= 1, "the panel must announce how many guards it is tailing");
    expect(chain.deliveredEvents).toBe(MIXED_FEED_TOTAL * tailedCount);

    // ── Topic filter ───────────────────────────────────────────────────────
    await feed(page).getByLabel("Topic filter").selectOption(GUARD_EVENT_TOPICS.heartbeat);
    await expect(rows).toHaveCount(MIXED_FEED_COUNTS.heartbeat);
    await feed(page).getByLabel("Topic filter").selectOption("all");
    await expect(rows).toHaveCount(MIXED_FEED_TOTAL);

    // ── Contract search ────────────────────────────────────────────────────
    const contractSearch = feed(page).getByLabel("Contract address search");
    await contractSearch.fill(WATCHED_GUARD);
    await expect(rows).toHaveCount(MIXED_FEED_TOTAL);
    await contractSearch.fill("CNOTAREALCONTRACTADDRESS");
    await expect(rows).toHaveCount(0);
    await expect(feed(page)).toContainText(`The feed still holds ${MIXED_FEED_TOTAL} event(s)`);
    await contractSearch.fill("");
    await expect(rows).toHaveCount(MIXED_FEED_TOTAL);

    // ── Verdict filter: "Blocked Only" ─────────────────────────────────────
    await feed(page).getByLabel("Verdict filter").selectOption("blocked");
    await expect(rows).toHaveCount(MIXED_FEED_COUNTS.blocked);
    await expect(feed(page)).toContainText(
      `Showing ${MIXED_FEED_COUNTS.blocked} matching the current filter`,
    );
    // Every visible row really is a blocked decision: the reason pill is the
    // badge the blocked branch renders, and allowed rows carry a green one.
    await expect(feed(page).locator("table.events tbody tr .pill.danger")).toHaveCount(
      MIXED_FEED_COUNTS.blocked,
    );

    // ── CSV export of the filtered view ────────────────────────────────────
    // This branch exports the issue-#37 schema (docs/export-schema.md): the
    // column list is append-only and the file is BOM-prefixed so Excel opens
    // it as UTF-8. Strip the BOM before parsing, then assert the full column
    // list — including the columns this branch adds.
    const csv = await exportedText(feed(page), "Export CSV");
    expect(csv.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    const table = parseCsv(csv.replace(/^\uFEFF/, ""));
    expect(table[0]).toEqual([...EVENT_EXPORT_COLUMNS]);
    const dataRows = table.slice(1);
    expect(dataRows).toHaveLength(MIXED_FEED_COUNTS.blocked);

    const column = (name: string): number => EVENT_EXPORT_COLUMNS.indexOf(name as never);
    const ledgers = new Set<string>();
    for (const row of dataRows) {
      expect(row).toHaveLength(EVENT_EXPORT_COLUMNS.length);
      expect(row[column("schema_version")]).toBe("1");
      expect(row[column("guard")]).toBe(WATCHED_GUARD);
      expect(row[column("kind")]).toBe("auth_checked");
      expect(row[column("topic")]).toBe(GUARD_EVENT_TOPICS.authChecked);
      expect(row[column("decision")]).toBe("blocked");
      expect(row[column("reason")]).toBe(MIXED_FEED_BLOCK_REASON);
      expect(row[column("source")]).toBe("ledger");
      // The raw symbol is paired with the SDK's human explanation.
      expect(row[column("reason_label")]).toBe(explainReason(MIXED_FEED_BLOCK_REASON));
      expect(row[column("ledger")]).toMatch(/^\d+$/);
      expect(row[column("transaction_hash")]).toMatch(/^[0-9a-f]{64}$/);
      ledgers.add(row[column("ledger")]!);
    }
    // One row per event, with no duplicates standing in for missing ones.
    expect(ledgers.size).toBe(MIXED_FEED_COUNTS.blocked);

    // ── NDJSON export of the same filtered view ────────────────────────────
    const ndjson = await exportedText(feed(page), "Export NDJSON");
    const lines = ndjson.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(MIXED_FEED_COUNTS.blocked);
    expect(ndjson.endsWith("\n")).toBe(true);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record["kind"]).toBe("auth_checked");
      expect(record["topic"]).toBe(GUARD_EVENT_TOPICS.authChecked);
      expect(record["decision"]).toBe("blocked");
      expect(record["reason"]).toBe(MIXED_FEED_BLOCK_REASON);
      // The NDJSON button streams upstream's telemetryToNdjson, which keys the
      // emitting contract as contract_id (the CSV above is our exporter's
      // append-only schema, where the column is `guard`).
      expect(record["contract_id"]).toBe(WATCHED_GUARD);
      expect(String(record["ledger"])).toMatch(/^\d+$/);
    }
    // The two formats describe the same events, line for line.
    expect(lines.map((line) => (JSON.parse(line) as { ledger: string }).ledger)).toEqual(
      dataRows.map((row) => row[column("ledger")]!),
    );

    // ── Back to the unfiltered view ────────────────────────────────────────
    await feed(page).getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(MIXED_FEED_TOTAL);

    const fullCsv = parseCsv((await exportedText(feed(page), "Export CSV")).replace(/^\uFEFF/, ""));
    expect(fullCsv[0]).toEqual([...EVENT_EXPORT_COLUMNS]);
    expect(fullCsv).toHaveLength(MIXED_FEED_TOTAL + 1);

    const fullNdjson = (await exportedText(feed(page), "Export NDJSON"))
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(fullNdjson).toHaveLength(MIXED_FEED_TOTAL);

    // The full export's proportions are the fixture's: nothing was dropped,
    // duplicated or silently re-labelled on the way to disk.
    const decisions = fullCsv.slice(1).map((row) => row[column("decision")]!);
    const kinds = fullCsv.slice(1).map((row) => row[column("kind")]!);
    expect(decisions.filter((decision) => decision === "allowed")).toHaveLength(
      MIXED_FEED_COUNTS.approved,
    );
    expect(decisions.filter((decision) => decision === "blocked")).toHaveLength(
      MIXED_FEED_COUNTS.blocked,
    );
    expect(kinds.filter((kind) => kind === "heartbeat")).toHaveLength(MIXED_FEED_COUNTS.heartbeat);
  });
});
