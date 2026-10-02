import { useEffect, useState, useSyncExternalStore } from "react";

/** How many past snapshots are kept. Older ones are dropped first. */
export const HISTORY_LIMIT = 30;

/** Quiet time after the last text keystroke before an edit burst becomes one undo step. */
export const HISTORY_DEBOUNCE_MS = 400;

export interface HistoryOptions {
  limit?: number;
  debounceMs?: number;
}

export interface HistorySnapshot<T> {
  present: T;
  canUndo: boolean;
  canRedo: boolean;
  pastCount: number;
  futureCount: number;
}

/**
 * Undo/redo stack, kept free of React so it can be unit tested the same way as
 * ToastStore.
 *
 * - `push` records a discrete change (a toggle, a removed row) as its own step.
 * - `edit` is for text typing: the value updates immediately, but every edit
 *   made before the debounce window closes collapses into a single step.
 * - Making any new change after an undo drops the redo stack (a branching edit).
 */
export class HistoryStore<T> {
  readonly limit: number;
  readonly debounceMs: number;

  private past: T[] = [];
  private future: T[] = [];
  private present: T;
  // Wrapped so that `null` / `undefined` are valid states to remember.
  private pendingBase: { value: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: HistorySnapshot<T>;

  constructor(initial: T, options: HistoryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? HISTORY_LIMIT);
    this.debounceMs = Math.max(0, options.debounceMs ?? HISTORY_DEBOUNCE_MS);
    this.present = initial;
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): HistorySnapshot<T> => this.snapshot;

  push = (next: T): void => {
    if (Object.is(next, this.present)) return;
    this.flushPending();
    this.record(this.present);
    this.present = next;
    this.future = [];
    this.emit();
  };

  edit = (next: T): void => {
    if (Object.is(next, this.present)) return;
    if (this.pendingBase === null) this.pendingBase = { value: this.present };
    this.present = next;
    this.future = [];
    this.armTimer();
    this.emit();
  };

  undo = (): void => {
    this.flushPending();
    if (this.past.length === 0) return;
    this.future.push(this.present);
    this.present = this.past.pop() as T;
    this.emit();
  };

  redo = (): void => {
    this.flushPending();
    if (this.future.length === 0) return;
    this.record(this.present);
    this.present = this.future.pop() as T;
    this.emit();
  };

  reset = (value: T): void => {
    this.clearTimer();
    this.pendingBase = null;
    this.past = [];
    this.future = [];
    this.present = value;
    this.emit();
  };

  dispose = (): void => {
    this.clearTimer();
  };

  private record(value: T): void {
    this.past.push(value);
    while (this.past.length > this.limit) this.past.shift();
  }

  private flushPending(): void {
    this.clearTimer();
    if (this.pendingBase === null) return;
    this.record(this.pendingBase.value);
    this.pendingBase = null;
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushPending();
      this.emit();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private buildSnapshot(): HistorySnapshot<T> {
    const pending = this.pendingBase !== null ? 1 : 0;
    return {
      present: this.present,
      canUndo: this.past.length + pending > 0,
      canRedo: this.future.length > 0,
      pastCount: this.past.length + pending,
      futureCount: this.future.length,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }
}

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Maps a keydown to a history action: Cmd/Ctrl+Z is undo, Cmd/Ctrl+Shift+Z and
 * Ctrl+Y are redo. Anything else returns null so normal typing is untouched.
 */
export function historyShortcut(event: ShortcutEvent): "undo" | "redo" | null {
  if (event.altKey) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

export function useHistoryState<T>(initial: T, options?: HistoryOptions) {
  const [store] = useState(() => new HistoryStore<T>(initial, options));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => () => store.dispose(), [store]);

  return {
    state: snapshot.present,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    push: store.push,
    edit: store.edit,
    undo: store.undo,
    redo: store.redo,
    reset: store.reset,
  };
}
