import assert from "node:assert/strict";
import { test, before, afterEach, describe } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { LayoutShell } from "../../components/LayoutShell.tsx";

describe("LayoutShell", () => {
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

  test("renders desktop layout by default (width >= 768px)", async () => {
    // Mock window.innerWidth to be desktop size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Check that desktop elements are present
    assert.dom(document.body).containsText("Stellar Agent Guard");
    assert.dom(document.body).containsText("operator console");
    assert.dom(document.body).containsText("Soroban testnet");
    assert.dom(document.body).doesNotContainText("☰"); // Hamburger menu should not be visible on desktop
    assert.dom(document.body).containsText("test content");

    // Check that sidebar is present
    assert.ok(document.querySelector(".sidebar-container"));
    assert.ok(document.querySelector(".main-content"));

    // Check that mobile elements are not present
    assert.notOk(document.querySelector(".mobile-header"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
    assert.notOk(document.querySelector(".mobile-drawer"));
  });

  test("renders mobile layout when width < 768px", async () => {
    // Mock window.innerWidth to be mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Check that mobile elements are present
    assert.dom(document.body).containsText("Stellar Agent Guard");
    assert.dom(document.body).containsText("operator console");
    assert.dom(document.body).containsText("☰"); // Hamburger menu should be visible on mobile
    assert.dom(document.body).containsText("test content");

    // Check that mobile header is present
    assert.ok(document.querySelector(".mobile-header"));

    // Check that desktop header is not present
    assert.notOk(document.querySelector("header.top"));

    // Initially drawer should be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });

  test("sidebar collapse state persists in localStorage", async () => {
    // Mock window.innerWidth to be desktop size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Initially sidebar should be expanded (collapsed = false)
    let sidebar = document.querySelector(".sidebar-container");
    assert.ok(sidebar);
    assert.strictEqual(sidebar?.classList.contains("collapsed"), false);

    // Click the sidebar toggle button to collapse it
    const toggleButton = document.querySelector(".sidebar-toggle") as HTMLButtonElement | null;
    assert.ok(toggleButton, "Sidebar toggle button should exist");
    toggleButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Sidebar should now be collapsed
    sidebar = document.querySelector(".sidebar-container");
    assert.ok(sidebar);
    assert.strictEqual(sidebar?.classList.contains("collapsed"), true);

    // Check that localStorage was updated
    assert.strictEqual(localStorage.getItem("sidebar-collapsed"), "true");

    // Reload the component - sidebar should remain collapsed
    act(() => {
      root!.unmount();
      root = null;
    });

    div.innerHTML = "";
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Sidebar should still be collapsed from localStorage
    sidebar = document.querySelector(".sidebar-container");
    assert.ok(sidebar);
    assert.strictEqual(sidebar?.classList.contains("collapsed"), true);
  });

  test("mobile drawer opens and closes correctly", async () => {
    // Mock window.innerWidth to be mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Initially drawer should be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));

    // Click the hamburger button to open drawer
    const hamburgerButton = document.querySelector(
      '.mobile-header button[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement | null;
    assert.ok(hamburgerButton, "Hamburger button should exist");
    hamburgerButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should now be open
    assert.ok(document.querySelector(".mobile-drawer"));
    assert.ok(document.querySelector(".mobile-backdrop"));
    assert.ok(document.querySelector('[aria-modal="true"]'));

    // Click the close button in drawer
    const closeButton = document.querySelector(
      '.mobile-drawer-header button[aria-label="Close navigation menu"]',
    ) as HTMLButtonElement | null;
    assert.ok(closeButton, "Close button should exist");
    closeButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should now be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));

    // Click on backdrop to close drawer (alternative method)
    hamburgerButton?.click();
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    const backdrop = document.querySelector<HTMLElement>(".mobile-backdrop");
    assert.ok(backdrop, "Backdrop should exist when drawer is open");
    backdrop?.click();

    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });

  test("escape key closes mobile drawer", async () => {
    // Mock window.innerWidth to be mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Open the drawer
    const hamburgerButton = document.querySelector(
      '.mobile-header button[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement | null;
    hamburgerButton?.click();

    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be open
    assert.ok(document.querySelector(".mobile-drawer"));

    // Press Escape key
    const escapeKey = new KeyboardEvent("keydown", { key: "Escape" });
    window.dispatchEvent(escapeKey);

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });

  test("drawer closes when resizing from mobile to desktop", async () => {
    // Start with mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Open the drawer
    const hamburgerButton = document.querySelector(
      '.mobile-header button[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement | null;
    hamburgerButton?.click();

    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be open
    assert.ok(document.querySelector(".mobile-drawer"));

    // Resize to desktop width
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
    window.dispatchEvent(new window.Event("resize"));

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be closed when resized to desktop
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });
});
