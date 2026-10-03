/**
 * Cross-tab synchronisation for the operator console.
 *
 * An operator routinely keeps the console open on a wall monitor, a laptop and a
 * phone. When one of those tabs freezes an account, switches the active guard, or
 * installs a policy, the others must not keep showing the pre-action world until
 * someone reloads. This module is a small broadcast coordinator for that: tabs
 * announce what they did, and every other tab reacts locally.
 *
 * Two rules shape it, and both matter in an emergency:
 *
 *   1. The channel is *events*, not a state channel. Nothing here ships the new
 *      state; each tab re-reads the chain itself when it hears that something
 *      changed. A broadcast can therefore never become a second, staler source of
 *      truth than the contract.
 *   2. It degrades instead of failing. `BroadcastChannel` is not universally
 *      available (older Safari, some embedded webviews, jsdom), so the same
 *      events travel over `localStorage` `storage` events when it is not.
 *
 * The transport is injectable on purpose: unit tests drive two coordinators over
 * one mock channel bus rather than a real browser.
 */

/** The channel and storage key name. Versioned so a shape change cannot be misread. */
export const TAB_SYNC_CHANNEL = "stellar-agent-guard-dashboard.tab-sync.v1";
export const TAB_SYNC_STORAGE_KEY = "stellar-agent-guard-dashboard.tab-sync.v1";

/**
 * The state changes that are worth telling the other tabs about.
 *
 * `GUARD_CHANGED` carries a guard address and asks the receiving tab to switch to
 * it. The rest carry no state: they say only that the chain moved, so the
 * receiving tab re-reads. That split is deliberate — the freeze and policy
 * payloads are the chain's to describe, not this module's.
 */
export type TabSyncEventType =
  "GUARD_CHANGED" | "FREEZE_STATE_CHANGED" | "WALLET_DISCONNECTED" | "POLICY_UPDATED";

export const TAB_SYNC_EVENT_TYPES: readonly TabSyncEventType[] = [
  "GUARD_CHANGED",
  "FREEZE_STATE_CHANGED",
  "WALLET_DISCONNECTED",
  "POLICY_UPDATED",
];

/** One announcement. `origin` lets a tab ignore its own broadcast. */
export interface TabSyncEvent {
  type: TabSyncEventType;
  /** Identity of the emitting tab. */
  origin: string;
  /** ISO-8601 emission time, for logging and tests. */
  at: string;
  /** The guard this concerns, when it concerns one. */
  guard?: string;
  /** Free-form detail. Read reactively, never as authoritative state. */
  payload?: Record<string, unknown>;
}

function isEventType(value: unknown): value is TabSyncEventType {
  return typeof value === "string" && (TAB_SYNC_EVENT_TYPES as readonly string[]).includes(value);
}

/** Validate an untrusted channel/storage payload before acting on it. */
export function isTabSyncEvent(value: unknown): value is TabSyncEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<TabSyncEvent>;
  if (!isEventType(event.type)) return false;
  if (typeof event.origin !== "string" || event.origin.length === 0) return false;
  if (typeof event.at !== "string") return false;
  if (event.guard !== undefined && typeof event.guard !== "string") return false;
  if (
    event.payload !== undefined &&
    (typeof event.payload !== "object" || event.payload === null)
  ) {
    return false;
  }
  return true;
}

// ── Transport seams ────────────────────────────────────────────────────────

/** The subset of `BroadcastChannel` the coordinator needs, so tests can fake it. */
export interface TabChannel {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type TabChannelFactory = (name: string) => TabChannel;

/** The subset of `Storage` the fallback needs. */
export interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A `storage` event, narrowed to the two fields the fallback reads. */
export interface TabStorageEvent {
  key: string | null;
  newValue: string | null;
}

/** The subset of `window` the fallback needs. */
export interface TabEventTarget {
  addEventListener(type: "storage", listener: (event: TabStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: TabStorageEvent) => void): void;
}

export interface TabSyncOptions {
  channelName?: string;
  /** Identity for this tab. Defaults to a random id. */
  origin?: string;
  /**
   * Injected `BroadcastChannel` factory. Pass `null` to force the storage
   * fallback even where the API exists — which is how the fallback is tested.
   */
  channelFactory?: TabChannelFactory | null;
  storage?: TabStorage | null;
  eventTarget?: TabEventTarget | null;
  now?: () => Date;
  randomId?: () => string;
}

export interface TabSyncBroadcastOptions {
  guard?: string;
  payload?: Record<string, unknown>;
}

export interface TabSyncCoordinator {
  /** Which transport was actually chosen. */
  readonly transport: "broadcast" | "storage" | "none";
  readonly channelName: string;
  readonly origin: string;
  /** Announce a change. Returns the event that was sent. */
  broadcast(type: TabSyncEventType, options?: TabSyncBroadcastOptions): TabSyncEvent;
  /** Listen for events from *other* tabs. Returns an unsubscribe function. */
  subscribe(listener: (event: TabSyncEvent) => void): () => void;
  /** Release the channel and drop all listeners. */
  close(): void;
  readonly closed: boolean;
}

/** The envelope written to the fallback key: the event plus a fresh nonce. */
interface StorageEnvelope {
  nonce: string;
  event: TabSyncEvent;
}

function defaultRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultChannelFactory(): TabChannelFactory | null {
  // `window` is required, not just the constructor: Node 18+ ships a global
  // `BroadcastChannel`, and constructing one during server rendering would open a
  // real port in the build worker for a "tab" that does not exist.
  if (typeof window === "undefined") return null;
  if (typeof BroadcastChannel === "undefined") return null;
  return (name: string) => new BroadcastChannel(name) as unknown as TabChannel;
}

function defaultStorage(): TabStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage access itself can throw (private mode, disabled cookies).
    return null;
  }
}

function defaultEventTarget(): TabEventTarget | null {
  if (typeof window === "undefined") return null;
  return window as unknown as TabEventTarget;
}

// ── Shared coordinator shell ───────────────────────────────────────────────

/**
 * The listener bookkeeping every transport shares: validate, drop our own echo,
 * fan out, and stop the moment the coordinator is closed.
 */
function createCoordinatorShell(params: {
  transport: TabSyncCoordinator["transport"];
  channelName: string;
  origin: string;
  now: () => Date;
  receive: (deliver: (event: TabSyncEvent) => void) => () => void;
  send: (event: TabSyncEvent) => void;
  /** Transport-specific teardown, run exactly once by `close()`. */
  onClose?: () => void;
}): TabSyncCoordinator {
  const listeners = new Set<(event: TabSyncEvent) => void>();
  let closed = false;
  let detach: (() => void) | null = null;

  const deliver = (event: TabSyncEvent): void => {
    if (closed) return;
    // A broadcast is never delivered back to its sender by a well-behaved
    // transport, but the storage fallback and mock buses can echo — an operator
    // must not have their own action replayed at them.
    if (event.origin === params.origin) return;
    for (const listener of [...listeners]) listener(event);
  };

  return {
    transport: params.transport,
    channelName: params.channelName,
    origin: params.origin,
    get closed() {
      return closed;
    },
    broadcast(type, options = {}) {
      const event: TabSyncEvent = {
        type,
        origin: params.origin,
        at: params.now().toISOString(),
        ...(options.guard === undefined ? {} : { guard: options.guard }),
        ...(options.payload === undefined ? {} : { payload: options.payload }),
      };
      if (closed) return event;
      // Keep the subscription warm even with no listeners yet, so the first
      // receiving tab does not race the first broadcast.
      detach ??= params.receive(deliver);
      params.send(event);
      return event;
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      detach ??= params.receive(deliver);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      detach?.();
      detach = null;
      params.onClose?.();
    },
  };
}

// ── BroadcastChannel transport ─────────────────────────────────────────────

function createBroadcastCoordinator(params: {
  channelName: string;
  origin: string;
  now: () => Date;
  createChannel: TabChannelFactory;
}): TabSyncCoordinator {
  let channel: TabChannel | null = null;

  const channelFor = (): TabChannel => {
    channel ??= params.createChannel(params.channelName);
    return channel;
  };

  return createCoordinatorShell({
    transport: "broadcast",
    channelName: params.channelName,
    origin: params.origin,
    now: params.now,
    receive: (deliver) => {
      const active = channelFor();
      const onMessage = (event: { data: unknown }): void => {
        if (isTabSyncEvent(event.data)) deliver(event.data);
      };
      active.addEventListener("message", onMessage);
      return () => active.removeEventListener("message", onMessage);
    },
    send: (event) => channelFor().postMessage(event),
    onClose: () => {
      channel?.close();
      channel = null;
    },
  });
}

// ── localStorage fallback transport ────────────────────────────────────────

function createStorageCoordinator(params: {
  channelName: string;
  origin: string;
  now: () => Date;
  storage: TabStorage;
  eventTarget: TabEventTarget;
  randomId: () => string;
}): TabSyncCoordinator {
  const { storage, eventTarget } = params;

  const coordinator = createCoordinatorShell({
    transport: "storage",
    channelName: params.channelName,
    origin: params.origin,
    now: params.now,
    receive: (deliver) => {
      const onStorage = (event: TabStorageEvent): void => {
        if (event.key !== TAB_SYNC_STORAGE_KEY || !event.newValue) return;
        let envelope: unknown;
        try {
          envelope = JSON.parse(event.newValue);
        } catch {
          // A half-written or foreign value is not an event; ignore it.
          return;
        }
        if (typeof envelope !== "object" || envelope === null) return;
        const candidate = (envelope as Partial<StorageEnvelope>).event;
        if (isTabSyncEvent(candidate)) deliver(candidate);
      };
      eventTarget.addEventListener("storage", onStorage);
      return () => eventTarget.removeEventListener("storage", onStorage);
    },
    send: (event) => {
      // The nonce is load-bearing: `storage` events only fire when the value
      // actually changes, so two identical freezes in a row would otherwise be
      // silently deduplicated by the browser and the second tab would miss it.
      const envelope: StorageEnvelope = { nonce: params.randomId(), event };
      try {
        storage.setItem(TAB_SYNC_STORAGE_KEY, JSON.stringify(envelope));
      } catch {
        // Private-mode quota/write failures must not break the operator action.
      }
    },
  });

  return coordinator;
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Build the coordinator for this tab.
 *
 * Prefers `BroadcastChannel` and falls back to `localStorage` `storage` events.
 * When neither exists (server rendering, a locked-down webview) it returns an
 * inert coordinator: broadcasting is a no-op and nothing is ever received, so
 * callers never have to branch on availability.
 */
export function createTabSync(options: TabSyncOptions = {}): TabSyncCoordinator {
  const channelName = options.channelName ?? TAB_SYNC_CHANNEL;
  const randomId = options.randomId ?? defaultRandomId;
  const origin = options.origin ?? randomId();
  const now = options.now ?? (() => new Date());

  const channelFactory =
    options.channelFactory === undefined ? defaultChannelFactory() : options.channelFactory;
  if (channelFactory) {
    return createBroadcastCoordinator({ channelName, origin, now, createChannel: channelFactory });
  }

  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const eventTarget =
    options.eventTarget === undefined ? defaultEventTarget() : options.eventTarget;
  if (storage && eventTarget) {
    return createStorageCoordinator({ channelName, origin, now, storage, eventTarget, randomId });
  }

  return createCoordinatorShell({
    transport: "none",
    channelName,
    origin,
    now,
    receive: () => () => {},
    send: () => {},
  });
}
