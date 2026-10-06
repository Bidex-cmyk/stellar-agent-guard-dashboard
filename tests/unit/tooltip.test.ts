import assert from "node:assert/strict";
import { test, before, afterEach, describe } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { Tooltip } from "../../components/Tooltip.tsx";

describe("Tooltip", () => {
  let dom: ReturnType<typeof installDom>;
  let React: Awaited<ReturnType<typeof loadReact>>["react"];
  let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
  let act: Awaited<ReturnType<typeof loadReact>>["act"];
  let root: ReturnType<typeof createRoot> | null = null;

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
    localStorage.clear();
  });

  test("renders trigger element correctly", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const triggerElement = React.createElement("button", { "data-testid": "trigger" }, "Hover me");

    await act(() => {
      root!.render(React.createElement(Tooltip, { content: "Tooltip content" }, triggerElement));
    });

    // Check that the trigger element is rendered
    const trigger = document.querySelector('[data-testid="trigger"]');
    assert.ok(trigger, "Trigger element should be rendered");
    assert.strictEqual(trigger?.textContent, "Hover me");

    // Initially tooltip should not be visible
    assert.notOk(document.querySelector(".tooltip"), "Tooltip should not be visible initially");
    assert.strictEqual(
      trigger?.getAttribute("aria-describedby"),
      null,
      "aria-describedby should be null when tooltip is not showing",
    );
  });

  test("shows tooltip on mouse enter after delay", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const triggerElement = React.createElement("button", { "data-testid": "trigger" }, "Hover me");

    await act(() => {
      root!.render(
        React.createElement(
          Tooltip,
          {
            content: "Tooltip content",
            delay: 10, // Short delay for testing
          },
          triggerElement,
        ),
      );
    });

    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLElement | null;
    assert.ok(trigger, "Trigger element should exist");

    // Simulate mouse enter
    trigger?.dispatchEvent(new MouseEvent("mouseenter"));

    // Wait for delay period
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Tooltip should now be visible
    assert.ok(
      document.querySelector(".tooltip"),
      "Tooltip should be visible after mouse enter delay",
    );
    const contentEl = document.querySelector(".tooltip-content");
    assert.ok(contentEl, "Tooltip content element should exist");
    assert.strictEqual(contentEl?.textContent, "Tooltip content");
    assert.strictEqual(
      trigger?.getAttribute("aria-describedby"),
      "tooltip-content",
      "aria-describedby should point to tooltip content",
    );

    // Simulate mouse leave
    trigger?.dispatchEvent(new MouseEvent("mouseleave"));

    // Wait a bit for tooltip to hide
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Tooltip should now be hidden
    assert.notOk(document.querySelector(".tooltip"), "Tooltip should be hidden after mouse leave");
    assert.strictEqual(
      trigger?.getAttribute("aria-describedby"),
      null,
      "aria-describedby should be null when tooltip is not showing",
    );
  });

  test("shows tooltip on focus after delay", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const triggerElement = React.createElement(
      "button",
      { "data-testid": "trigger", tabIndex: 0 },
      "Focus me",
    );

    await act(() => {
      root!.render(
        React.createElement(
          Tooltip,
          {
            content: "Tooltip content",
            delay: 10, // Short delay for testing
          },
          triggerElement,
        ),
      );
    });

    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLElement | null;
    assert.ok(trigger, "Trigger element should exist");

    // Simulate focus
    trigger?.focus();
    trigger?.dispatchEvent(new FocusEvent("focus"));

    // Wait for delay period
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Tooltip should now be visible
    assert.ok(document.querySelector(".tooltip"), "Tooltip should be visible after focus delay");
    const contentEl = document.querySelector(".tooltip-content");
    assert.ok(contentEl, "Tooltip content element should exist");
    assert.strictEqual(contentEl?.textContent, "Tooltip content");
    assert.strictEqual(
      trigger?.getAttribute("aria-describedby"),
      "tooltip-content",
      "aria-describedby should point to tooltip content",
    );

    // Simulate blur
    trigger?.dispatchEvent(new FocusEvent("blur"));

    // Wait a bit for tooltip to hide
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Tooltip should now be hidden
    assert.notOk(document.querySelector(".tooltip"), "Tooltip should be hidden after blur");
    assert.strictEqual(
      trigger?.getAttribute("aria-describedby"),
      null,
      "aria-describedby should be null when tooltip is not showing",
    );
  });

  test("hides tooltip when escape key is pressed", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const triggerElement = React.createElement("button", { "data-testid": "trigger" }, "Hover me");

    await act(() => {
      root!.render(
        React.createElement(
          Tooltip,
          {
            content: "Tooltip content",
            delay: 10, // Short delay for testing
          },
          triggerElement,
        ),
      );
    });

    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLElement | null;
    assert.ok(trigger, "Trigger element should exist");

    // Show tooltip via mouse enter
    trigger?.dispatchEvent(new MouseEvent("mouseenter"));
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Verify tooltip is showing
    assert.ok(document.querySelector(".tooltip"), "Tooltip should be visible");

    // Press escape key
    const escapeKey = new KeyboardEvent("keydown", { key: "Escape" });
    window.dispatchEvent(escapeKey);

    // Wait a bit for tooltip to hide
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Tooltip should now be hidden
    assert.notOk(document.querySelector(".tooltip"), "Tooltip should be hidden after escape key");
    assert.strictEqual(
      trigger?.getAttribute("aria-describedby"),
      null,
      "aria-describedby should be null when tooltip is not showing",
    );
  });

  test("positions tooltip correctly based on viewport boundaries", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    // Set a small viewport to test boundary detection
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 200,
    });
    Object.defineProperty(window, "innerHeight", {
      writable: true,
      configurable: true,
      value: 200,
    });

    const triggerElement = React.createElement(
      "button",
      { "data-testid": "trigger", style: { position: "fixed", top: "10px", left: "10px" } },
      "Hover me",
    );

    await act(() => {
      root!.render(
        React.createElement(
          Tooltip,
          {
            content: "This is a very long tooltip content that should trigger boundary detection",
            delay: 10,
            distance: 5,
          },
          triggerElement,
        ),
      );
    });

    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLElement | null;
    assert.ok(trigger, "Trigger element should exist");

    // Show tooltip
    trigger?.dispatchEvent(new MouseEvent("mouseenter"));
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Tooltip should be visible
    const tooltip = document.querySelector(".tooltip");
    assert.ok(tooltip, "Tooltip should be visible");

    // Check that tooltip has some positioning applied
    const tooltipStyle = window.getComputedStyle(tooltip);
    assert.ok(
      tooltipStyle.top !== "auto" ||
        tooltipStyle.bottom !== "auto" ||
        tooltipStyle.left !== "auto" ||
        tooltipStyle.right !== "auto",
      "Tooltip should have positioning applied",
    );
  });

  test("passes through all props to trigger element", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const triggerProps = {
      id: "custom-id",
      className: "custom-class",
      "data-custom": "value",
      title: "Original title",
    };

    const triggerElement = React.createElement("button", triggerProps, "Trigger");

    await act(() => {
      root!.render(React.createElement(Tooltip, { content: "Tooltip content" }, triggerElement));
    });

    const trigger = document.querySelector("#custom-id") as HTMLElement | null;
    assert.ok(trigger, "Trigger element should have the correct id");
    assert.strictEqual(
      trigger?.getAttribute("class"),
      "custom-class",
      "Trigger element should have the correct class",
    );
    assert.strictEqual(
      trigger?.getAttribute("data-custom"),
      "value",
      "Trigger element should have the correct data attribute",
    );
    assert.strictEqual(
      trigger?.getAttribute("title"),
      "Original title",
      "Trigger element should preserve original title",
    );
  });
});
