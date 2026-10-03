import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { ThemeProvider, useTheme } from "../../components/ThemeProvider.tsx";

let dom: ReturnType<typeof installDom>;
let React: Awaited<ReturnType<typeof loadReact>>["react"];
let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
let act: Awaited<ReturnType<typeof loadReact>>["act"];
let root: ReturnType<typeof createRoot> | null = null;
let mediaQueryCallbacks: Set<Function> = new Set();
let matchMediaResult = false;

before(async () => {
  dom = installDom();
  const reactDeps = await loadReact();
  React = reactDeps.react;
  createRoot = reactDeps.createRoot;
  act = reactDeps.act;

  // Mock matchMedia
  window.matchMedia = ((query: string) => {
    return {
      matches: matchMediaResult,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (type: string, listener: Function) => {
        if (type === "change") mediaQueryCallbacks.add(listener);
      },
      removeEventListener: (type: string, listener: Function) => {
        if (type === "change") mediaQueryCallbacks.delete(listener);
      },
      dispatchEvent: () => true,
    } as any;
  }) as any;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  mediaQueryCallbacks.clear();
  matchMediaResult = false;
});

test("initializes with prefers-color-scheme when no localStorage", async () => {
  matchMediaResult = true; // prefers light
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  let currentTheme = "";
  function TestChild() {
    const { theme } = useTheme();
    currentTheme = theme;
    return React.createElement("div", null, theme);
  }

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement(TestChild)));
  });

  assert.equal(currentTheme, "light");
  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
});

test("initializes with localStorage if set", async () => {
  localStorage.setItem("theme", "high-contrast");
  matchMediaResult = true; // prefers light but localStorage should win

  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  let currentTheme = "";
  function TestChild() {
    const { theme } = useTheme();
    currentTheme = theme;
    return React.createElement("div", null, theme);
  }

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement(TestChild)));
  });

  assert.equal(currentTheme, "high-contrast");
  assert.equal(document.documentElement.getAttribute("data-theme"), "high-contrast");
});

test("updates theme and persists to localStorage on change", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  let setThemeFn: any;
  function TestChild() {
    const { setTheme } = useTheme();
    setThemeFn = setTheme;
    return null;
  }

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement(TestChild)));
  });

  await act(() => {
    setThemeFn("dark");
  });

  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(localStorage.getItem("theme"), "dark");
});

test("listens to media query changes if no localStorage set", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement("div")));
  });

  assert.equal(document.documentElement.getAttribute("data-theme"), "dark"); // initial matchMedia=false

  await act(() => {
    mediaQueryCallbacks.forEach((cb) => cb({ matches: true })); // Change to light
  });

  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
});
