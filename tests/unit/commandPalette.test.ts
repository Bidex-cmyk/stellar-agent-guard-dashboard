import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import { installDom, loadReact, Act as _act } from "./domHarness.ts";
import { fuzzyMatch } from "../../lib/guard/commands.ts";
import { CommandPaletteInner } from "../../components/CommandPalette.tsx";

let dom: ReturnType<typeof installDom>;
let React: Awaited<ReturnType<typeof loadReact>>["react"];
let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
let act: _act;
let root: ReturnType<typeof createRoot> | null = null;

let selectGuardCalledWith = "";

before(async () => {
  dom = installDom();
  const reactDeps = await loadReact();
  React = reactDeps.react;
  createRoot = reactDeps.createRoot;
  act = reactDeps.act;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
  selectGuardCalledWith = "";
});

test("fuzzyMatch works correctly", () => {
  assert.equal(fuzzyMatch("nav", "Go to Navigation"), true);
  assert.equal(fuzzyMatch("cmd", "Command"), true);
  assert.equal(fuzzyMatch("xyz", "Command"), false);
});

test("opens on Cmd+K, filters commands, and dispatches action on Enter", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  const mockRouter = { push: () => {} };
  const mockInstances = [{ guard: "GABC...", label: "My Guard" }];

  await act(() => {
    root!.render(
      React.createElement(CommandPaletteInner, {
        router: mockRouter,
        guard: "GBM...",
        instances: mockInstances,
        selectGuard: (a: string) => {
          selectGuardCalledWith = a;
        },
      }),
    );
  });

  await act(() => {
    const event = new window.KeyboardEvent("keydown", { key: "k", metaKey: true });
    document.dispatchEvent(event);
  });

  const input = div.querySelector('input[role="combobox"]') as HTMLInputElement;
  assert.ok(input);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(() => {
    nativeInputValueSetter?.call(input, "Switch to My");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });

  await act(() => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });

  await act(() => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  assert.equal(selectGuardCalledWith, "GABC...");
});
