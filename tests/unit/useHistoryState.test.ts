import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";
import { HISTORY_LIMIT, HistoryStore, historyShortcut } from "../../lib/guard/useHistoryState.ts";

const HISTORY_DEBOUNCE = 400;

describe("HistoryStore (issue #78)", () => {
  let store: HistoryStore<string>;

  beforeEach(() => {
    store = new HistoryStore<string>("");
  });

  it("starts with nothing to undo or redo", () => {
    const snap = store.getSnapshot();
    assert.equal(snap.present, "");
    assert.equal(snap.canUndo, false);
    assert.equal(snap.canRedo, false);
  });

  it("push records the previous state and updates the present", () => {
    store.push("a");
    store.push("b");
    const snap = store.getSnapshot();
    assert.equal(snap.present, "b");
    assert.equal(snap.pastCount, 2);
    assert.equal(snap.canUndo, true);
  });

  it("ignores a push of the identical value", () => {
    store.push("a");
    store.push("a");
    assert.equal(store.getSnapshot().pastCount, 1);
  });

  it("undo and redo walk back and forward through the history", () => {
    store.push("a");
    store.push("b");
    store.undo();
    assert.equal(store.getSnapshot().present, "a");
    store.undo();
    assert.equal(store.getSnapshot().present, "");
    assert.equal(store.getSnapshot().canUndo, false);
    store.redo();
    assert.equal(store.getSnapshot().present, "a");
    store.redo();
    assert.equal(store.getSnapshot().present, "b");
    assert.equal(store.getSnapshot().canRedo, false);
  });

  it("undo and redo are no-ops at the ends of the stack", () => {
    store.undo();
    store.redo();
    assert.equal(store.getSnapshot().present, "");
    store.push("a");
    store.redo();
    assert.equal(store.getSnapshot().present, "a");
  });

  it("truncates the redo stack when an edit branches after an undo", () => {
    store.push("a");
    store.push("b");
    store.push("c");
    store.undo();
    store.undo();
    assert.equal(store.getSnapshot().futureCount, 2);
    store.push("x");
    const snap = store.getSnapshot();
    assert.equal(snap.present, "x");
    assert.equal(snap.futureCount, 0);
    assert.equal(snap.canRedo, false);
    store.undo();
    assert.equal(store.getSnapshot().present, "a");
  });

  it("keeps at most 30 past snapshots and drops the oldest", () => {
    assert.equal(HISTORY_LIMIT, 30);
    for (let i = 1; i <= 40; i += 1) store.push(String(i));
    assert.equal(store.getSnapshot().pastCount, 30);
    for (let i = 0; i < 100; i += 1) store.undo();
    assert.equal(store.getSnapshot().present, "10");
    assert.equal(store.getSnapshot().canUndo, false);
  });

  it("can remember null as a real state", () => {
    const nullable = new HistoryStore<string | null>(null);
    nullable.push("draft");
    nullable.undo();
    assert.equal(nullable.getSnapshot().present, null);
    assert.equal(nullable.getSnapshot().canRedo, true);
  });

  it("notifies subscribers until they unsubscribe", () => {
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.push("a");
    store.undo();
    assert.equal(calls, 2);
    unsubscribe();
    store.redo();
    assert.equal(calls, 2);
  });

  it("reset clears both stacks", () => {
    store.push("a");
    store.undo();
    store.reset("fresh");
    const snap = store.getSnapshot();
    assert.equal(snap.present, "fresh");
    assert.equal(snap.canUndo, false);
    assert.equal(snap.canRedo, false);
  });

  describe("debounced text edits", () => {
    it("collapses a burst of keystrokes into one undo step", () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        store.edit("h");
        mock.timers.tick(100);
        store.edit("he");
        mock.timers.tick(100);
        store.edit("hel");
        assert.equal(store.getSnapshot().present, "hel");
        mock.timers.tick(HISTORY_DEBOUNCE);
        assert.equal(store.getSnapshot().pastCount, 1);
        store.undo();
        assert.equal(store.getSnapshot().present, "");
        assert.equal(store.getSnapshot().canUndo, false);
      } finally {
        mock.timers.reset();
      }
    });

    it("undo before the debounce fires still reverts the whole burst", () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        store.edit("a");
        store.edit("ab");
        assert.equal(store.getSnapshot().canUndo, true);
        store.undo();
        assert.equal(store.getSnapshot().present, "");
        store.redo();
        assert.equal(store.getSnapshot().present, "ab");
      } finally {
        mock.timers.reset();
      }
    });

    it("a pause longer than the window starts a new step", () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        store.edit("a");
        mock.timers.tick(HISTORY_DEBOUNCE);
        store.edit("ab");
        mock.timers.tick(HISTORY_DEBOUNCE);
        assert.equal(store.getSnapshot().pastCount, 2);
        store.undo();
        assert.equal(store.getSnapshot().present, "a");
      } finally {
        mock.timers.reset();
      }
    });

    it("a discrete push closes the pending burst first", () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        store.edit("typed");
        store.push("toggled");
        store.undo();
        assert.equal(store.getSnapshot().present, "typed");
        store.undo();
        assert.equal(store.getSnapshot().present, "");
      } finally {
        mock.timers.reset();
      }
    });

    it("typing after an undo truncates the redo stack", () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        store.push("a");
        store.push("b");
        store.undo();
        store.edit("az");
        assert.equal(store.getSnapshot().canRedo, false);
        mock.timers.tick(HISTORY_DEBOUNCE);
        store.undo();
        assert.equal(store.getSnapshot().present, "a");
      } finally {
        mock.timers.reset();
      }
    });
  });
});

describe("historyShortcut (issue #78)", () => {
  const base = { key: "z", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it("maps Ctrl+Z and Cmd+Z to undo", () => {
    assert.equal(historyShortcut({ ...base, ctrlKey: true }), "undo");
    assert.equal(historyShortcut({ ...base, metaKey: true }), "undo");
  });

  it("maps Ctrl+Shift+Z, Cmd+Shift+Z and Ctrl+Y to redo", () => {
    assert.equal(historyShortcut({ ...base, ctrlKey: true, shiftKey: true, key: "Z" }), "redo");
    assert.equal(historyShortcut({ ...base, metaKey: true, shiftKey: true, key: "Z" }), "redo");
    assert.equal(historyShortcut({ ...base, ctrlKey: true, key: "y" }), "redo");
  });

  it("leaves ordinary typing and other chords alone", () => {
    assert.equal(historyShortcut(base), null);
    assert.equal(historyShortcut({ ...base, ctrlKey: true, key: "c" }), null);
    assert.equal(historyShortcut({ ...base, ctrlKey: true, altKey: true }), null);
    assert.equal(historyShortcut({ ...base, ctrlKey: true, shiftKey: true, key: "y" }), null);
  });
});
