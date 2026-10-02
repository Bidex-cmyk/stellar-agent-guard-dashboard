import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Responsive stylesheet contract for /configure (upstream issue #35).
 *
 * jsdom has no layout engine, so layout itself cannot be asserted here — the
 * plain-CSS equivalent of a class-contract test asserts the *stylesheet
 * wiring*: the media-query block exists, the responsive rules are inside it,
 * and the form component actually uses the classes. Real layout proof is the
 * manual 375px screenshot check named in the PR (reviewer checklist), with
 * Playwright viewport tests as the tracked follow-up.
 */

const stylesheet = readFileSync("app/globals.css", "utf8");
const formSource = readFileSync("components/PolicyForm.tsx", "utf8");

/** Extract a top-level `@media` block's body by brace matching. */
function mediaBlock(query: string): string {
  const start = stylesheet.indexOf(`@media ${query}`);
  assert.ok(start >= 0, `expected an @media ${query} block in globals.css`);
  let depth = 0;
  let i = stylesheet.indexOf("{", start);
  const open = i;
  for (; i < stylesheet.length; i++) {
    if (stylesheet[i] === "{") depth += 1;
    if (stylesheet[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return stylesheet.slice(open, i + 1);
}

test("responsive contract: rules live inside the 720px media block", async (t) => {
  const block = mediaBlock("(max-width: 720px)");

  await t.test("split collapses to one column under the breakpoint", () => {
    assert.match(block, /\.split\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  await t.test("form action bar stacks full-width buttons (touch-height 44px)", () => {
    assert.match(block, /\.form-actions\s*\{[^}]*flex-direction:\s*column/);
    assert.match(block, /\.form-actions button\s*\{[^}]*min-height:\s*44px/);
    assert.match(block, /\.form-actions button\s*\{[^}]*width:\s*100%/);
  });

  await t.test("list-editor remove buttons get a >=44px touch target", () => {
    assert.match(block, /\.asset-caps button\.secondary\s*\{[^}]*min-height:\s*44px/);
  });

  await t.test("inline date-range pair stacks instead of overflowing", () => {
    assert.match(block, /\.form-inline-row\s*\{[^}]*flex-direction:\s*column/);
  });
});

test("responsive contract: the form actually uses the classes", async (t) => {
  await t.test("PolicyForm's action bar carries the sticky .form-actions class", () => {
    assert.match(formSource, /className="form-actions row"/);
  });

  await t.test("PolicyForm's inline date pair carries .form-inline-row", () => {
    assert.match(formSource, /className="row form-inline-row"/);
  });

  await t.test("action bar is sticky below the fold (sticky positioning wired)", () => {
    const sticky = stylesheet.match(/\.form-actions\s*\{[^}]*position:\s*sticky/);
    assert.ok(sticky, "expected .form-actions { position: sticky; ... } outside the media block");
  });
});
