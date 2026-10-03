import assert from "node:assert/strict";
import { describe, it, before, test } from "node:test";
import { formatTimeAgo } from "../../lib/guard/time.ts";
import { installDom, loadReact, type Act } from "./domHarness.ts";
import { TimeAgo } from "../../components/bits.tsx";
import fs from "node:fs/promises";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

describe("formatTimeAgo", () => {
  const fixedNow = 1700000000n; // arbitrary deterministic "now"

  it("returns 'just now' for diff < 10s (boundary at 9s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 0n, fixedNow), "just now");
    assert.equal(formatTimeAgo(fixedNow - 9n, fixedNow), "just now");
  });

  it("returns seconds for diff < 60s (boundary at 10s and 59s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 10n, fixedNow), "10s");
    assert.equal(formatTimeAgo(fixedNow - 59n, fixedNow), "59s");
  });

  it("returns minutes for diff < 60m (boundary at 60s and 3599s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 60n, fixedNow), "1m");
    assert.equal(formatTimeAgo(fixedNow - 119n, fixedNow), "1m");
    assert.equal(formatTimeAgo(fixedNow - 3599n, fixedNow), "59m");
  });

  it("returns hours for diff < 24h (boundary at 3600s and 86399s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 3600n, fixedNow), "1h");
    assert.equal(formatTimeAgo(fixedNow - 7199n, fixedNow), "1h");
    assert.equal(formatTimeAgo(fixedNow - 86399n, fixedNow), "23h");
  });

  it("returns days for diff >= 24h (boundary at 86400s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 86400n, fixedNow), "1d");
    assert.equal(formatTimeAgo(fixedNow - 172800n, fixedNow), "2d");
  });

  it("handles clock skew gracefully by capping at 0s (future timestamps)", () => {
    assert.equal(formatTimeAgo(fixedNow + 10n, fixedNow), "just now");
    assert.equal(formatTimeAgo(fixedNow + 3600n, fixedNow), "just now");
  });

  it("supports number input deterministically", () => {
    const fixedNowNum = 1700000000;
    assert.equal(formatTimeAgo(fixedNowNum - 45, fixedNowNum), "45s");
    assert.equal(formatTimeAgo(fixedNowNum - 4000, fixedNowNum), "1h");
  });
});

test("<TimeAgo /> renders relative text and absolute ISO timestamp attributes", async () => {
  const fixtureUrl = new URL("../fixtures/phase3-proof.json", import.meta.url);
  const data = JSON.parse(await fs.readFile(fixtureUrl, "utf8"));
  const iso = data.ranAt;

  assert.equal(typeof iso, "string");

  const container = document.createElement("div");
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(react.createElement(TimeAgo, { iso }));
  });

  const timeEl = container.querySelector("time.timeago") as HTMLTimeElement;
  assert.ok(timeEl, "a <time> element should be rendered");

  assert.equal(timeEl.getAttribute("datetime"), iso);
  assert.equal(timeEl.getAttribute("title"), iso);

  const relText = timeEl.textContent;
  assert.ok(
    relText && /^(just now|\d+[smhd])$/.test(relText),
    `Rendered text "${relText}" should match relative time format`,
  );

  await act(async () => {
    root?.unmount();
  });
  container.remove();
});
