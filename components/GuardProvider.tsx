"use client";

/**
 * The console's client-side state: the wallet, the selected guard, a polled
 * snapshot of that guard, and the event feed.
 *
 * Two rules shape this provider, and both come from the same commitment — the
 * interface must never show a number it did not read from the chain:
 *
 *   1. A failed read is stored as an error, never as a default. `snapshot` keeps
 *      each field's own success/failure, and the panels render the failure.
 *   2. The feed is fed from two clearly-labelled sources. Ledger events are
 *      settled history; diagnostic events come from a refused write this console
 *      performed, and are labelled as such, because a rolled-back event is
 *      evidence of a refusal rather than of state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { rpc } from "@stellar/stellar-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { createServer } from "../lib/guard/chain.ts";
import { readGuardSnapshot, type GuardSnapshot } from "../lib/guard/guardOps.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { GuardFeed } from "../lib/guard/telemetry.ts";
import { createTabSync, type TabSyncEventType } from "../lib/guard/tabSync.ts";
import {
  KNOWN_INSTANCES,
  loadInstances,
  rememberInstance,
  type GuardInstance,
} from "../lib/guard/instance.ts";
import { currentAddress, freighterSigner, type ConnectedWallet } from "../lib/guard/wallet.ts";
import {
  WalletNotInstalledError,
  canReconnectSilently,
  connectorSigner,
  createWalletConnector,
  detectInstalledProviders,
  loadPreferredProvider,
  readWalletScope,
  savePreferredProvider,
  type WalletConnector,
  type WalletProviderId,
} from "../lib/guard/walletConnector.ts";
import {
  detectNetworkMismatch,
  loadFreighterNetworkApi,
  requestFreighterNetworkSwitch,
  type NetworkMismatch,
  type NetworkSwitchOutcome,
} from "../lib/guard/networkSwitch.ts";
import { isObserverSession, readSourceFor } from "../lib/guard/observerMode.ts";
import type { WalletSigner } from "../lib/guard/submit.ts";
import {
  useIdleTimer,
  loadIdleTimeoutMs,
  saveIdleTimeoutMs,
  type IdleState,
} from "../lib/guard/useIdleTimer.ts";
import {
  DEMO_BASE_LEDGER,
  DEMO_GUARD,
  DEMO_INSTANCE,
  demoEvents,
  demoFlagFromQuery,
  demoSnapshot,
  isDemoMode,
  syntheticDemoEvent,
} from "../lib/guard/demoFixtures.ts";
import { resolvePreset, validateRange, type RangePreset, type TimeRange } from "../lib/guard/ledgerTime.ts";

const SNAPSHOT_INTERVAL_MS = 15_000;
const FEED_INTERVAL_MS = 5_000;

/** Display labels for the historical-range presets, mirroring `ledgerTime.ts`. */
const RANGE_PRESET_LABELS: Record<Exclude<RangePreset, "custom">, string> = {
  "1h": "last 1 hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
};

interface GuardContextValue {
  server: rpc.Server;
  wallet: ConnectedWallet | null;
  walletError: string | null;
  connecting: boolean;
  /** Connect with an explicit provider, or with the one the operator last chose. */
  connect: (provider?: WalletProviderId) => Promise<void>;
  disconnect: () => void;
  /** A signer for the connected wallet, or a thrown error explaining why not. */
  signer: () => WalletSigner;
  /** The wallet this session connected through, once it has. */
  providerId: WalletProviderId | null;
  /** Wallets this browser can actually serve, probed without prompting. */
  availableProviders: WalletProviderId[];
  /** True while nobody is signing: reads work, writes are refused. */
  observer: boolean;
  /** The wallet/dashboard network disagreement, if there is one. */
  networkMismatch: NetworkMismatch | null;
  /** Ask the wallet to move to this dashboard's network; null when declined. */
  switchNetwork: () => Promise<NetworkSwitchOutcome | null>;
  instances: GuardInstance[];
  guard: string;
  selectGuard: (guard: string) => void;
  addInstance: (guard: string, label: string) => void;
  snapshot: GuardSnapshot | null;
  snapshotError: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  feed: {
    watching: boolean;
    latestLedger: number | null;
    error: string | null;
    lastPolledAt: string | null;
  };
  startWatching: () => void;
  stopWatching: () => void;
  clearEvents: () => void;
  /** Surface refused-write diagnostics in the feed, labelled as diagnostics. */
  pushEvents: (events: GuardEvent[]) => void;
  /**
   * Query the feed's guard over a historical time range (#148). Replaces the
   * live view with the window's events and labels it, so a historical result
   * is never mistaken for the live tail. In demo mode the window is answered
   * from the fixtures, since demo mode never touches RPC.
   */
  queryRange: (range: TimeRange, preset: RangePreset) => Promise<void>;
  /** Human-readable label of the range currently displayed, or null when live. */
  rangeLabel: string | null;
  /**
   * Tell the other open tabs that this one changed something. The provider adds
   * the active guard, so callers only name the change.
   */
  notifyTabs: (type: TabSyncEventType, options?: { payload?: Record<string, unknown> }) => void;
  /** Operator session auto-lock state and its configuration. */
  session: {
    state: IdleState;
    timeoutMs: number;
    setTimeoutMs: (valueMs: number) => void;
    stayConnected: () => void;
  };
}

const GuardContext = createContext<GuardContextValue | null>(null);

/**
 * The event feed lives in its own context, deliberately separate from the
 * console's general state.
 *
 * The feed is the only high-churn state here: batches arrive on every poll (or,
 * under the #114 benchmark's seam, on every animation frame), and if `events`
 * rode along on `GuardContext` then every value's identity would change with
 * every batch — re-rendering the wallet bar, status panel, panic panel and the
 * rest for a change only the telemetry table can see. Splitting the feed out
 * keeps the cost of a batch proportional to the one panel that renders it.
 * Only `TelemetryFeed` subscribes.
 */
const GuardEventsContext = createContext<GuardEvent[] | null>(null);

/** A stable identity for an event, so re-polling the same page cannot duplicate rows. */
function eventKey(event: GuardEvent): string {
  return [
    event.source,
    event.transactionHash ?? "-",
    event.ledger ?? "-",
    event.topic,
    event.decision?.result ?? "-",
    event.decision?.reason ?? "-",
    // The body is decoded ScVal: a heartbeat's `at` (and any other u64/i128)
    // is a `bigint`, which `JSON.stringify` refuses to serialise — the replacer
    // keeps the key derivable instead of throwing inside the feed's write path.
    typeof event.data === "object" && event.data !== null
      ? JSON.stringify(event.data, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        )
      : String(event.data),
  ].join("|");
}

export function GuardProvider({ children }: { children: ReactNode }) {
  const server = useMemo(() => createServer(NETWORK.rpcUrl), []);
  // The cross-tab coordinator. It is transport-agnostic (BroadcastChannel with a
  // localStorage fallback) and inert where neither exists, so the provider never
  // branches on availability. Created once per tab.
  const tabSync = useMemo(() => createTabSync(), []);
  // Demo mode is settled synchronously from the build-time flag, then re-checked
  // for `?demo=true` in an effect — the query string is not visible during SSR,
  // and reading it during render would desynchronise hydration.
  const [demo, setDemo] = useState<boolean>(() => isDemoMode());
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // The wallet scope is read once per tab: an injected `window.xbull` does not
  // appear mid-session, and re-probing on every render would mean a popup.
  const scope = useMemo(() => readWalletScope(), []);
  const [providerId, setProviderId] = useState<WalletProviderId | null>(() => loadPreferredProvider());
  const [availableProviders, setAvailableProviders] = useState<WalletProviderId[]>([]);
  const [networkMismatch, setNetworkMismatch] = useState<NetworkMismatch | null>(null);
  // The connector that produced the current session. Kept in a ref because a
  // re-render must never rebuild it — a fresh connector has not been granted
  // access, and rebuilding on render would prompt the operator again.
  const connectorRef = useRef<WalletConnector | null>(null);
  const [instances, setInstances] = useState<GuardInstance[]>(() =>
    isDemoMode() ? [DEMO_INSTANCE] : [...KNOWN_INSTANCES],
  );
  const [guard, setGuard] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const g = new URLSearchParams(window.location.search).get("guard");
      if (g) return g;
    }
    return isDemoMode() ? DEMO_GUARD : KNOWN_INSTANCES[0]!.guard;
  });
  const [snapshot, setSnapshot] = useState<GuardSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState<GuardEvent[]>([]);
  const [rangeLabel, setRangeLabel] = useState<string | null>(null);
  const [feed, setFeed] = useState<GuardContextValue["feed"]>({
    watching: false,
    latestLedger: null,
    error: null,
    lastPolledAt: null,
  });

  // The feed instance is kept in a ref so a re-render never resets its cursor —
  // losing the cursor would silently re-scan and re-deliver events.
  const feedRef = useRef<GuardFeed | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  // The active guard, readable from the (long-lived) sync listener without
  // re-subscribing on every guard change.
  const guardRef = useRef(guard);

  useEffect(() => {
    guardRef.current = guard;
  }, [guard]);

  // The coordinator is deliberately never closed by an effect cleanup: React's
  // development StrictMode mount/unmount/mount cycle would close the channel on
  // the simulated unmount and leave the tab permanently unable to broadcast. The
  // provider lives as long as the document, and the browser closes the channel
  // with the page.

  useEffect(() => {
    // Demo mode pins the selector to the single fixture instance, so a value the
    // fixtures do not describe can never be selected. Leaving demo mode restores
    // the remembered instances.
    if (demo) {
      setInstances([DEMO_INSTANCE]);
      setGuard(DEMO_GUARD);
      return;
    }
    setInstances(loadInstances());
  }, [demo]);

  // `?demo=true` is only visible in the browser, so demo mode is settled here.
  useEffect(() => {
    if (demoFlagFromQuery(window.location.search)) setDemo(true);
  }, []);

  // In demo mode the feed is seeded and watching immediately: a visitor should
  // see realistic telemetry without having to click "Start watching" first. The
  // fixtures never touch RPC, so this cannot fire a chain read.
  useEffect(() => {
    if (!demo) return;
    setEvents(demoEvents());
    setFeed((current) => ({ ...current, watching: true, latestLedger: DEMO_BASE_LEDGER, error: null }));
  }, [demo]);

  // Which wallets this browser can serve, probed without prompting so the
  // selection modal can show what is installable rather than what is guessed.
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void detectInstalledProviders(scope).then((found) => {
      if (!cancelled) setAvailableProviders(found);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, demo]);

  // Pick up an already-authorized wallet without prompting for access again.
  // Only for wallets whose reconnect is silent: asking a web popup wallet to
  // "just reconnect" would open a window on page load.
  useEffect(() => {
    if (demo) return;
    const preferred = loadPreferredProvider();
    if (!canReconnectSilently(preferred)) return;
    let cancelled = false;
    void (async () => {
      try {
        const address = await currentAddress();
        if (!address || cancelled) return;
        setWallet({ address, networkPassphrase: NETWORK.passphrase, network: NETWORK.name });
      } catch {
        // A wallet that is not installed is a normal state, not an error to show.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo]);

  const connect = useCallback(
    async (preferred?: WalletProviderId) => {
      const id = preferred ?? providerId ?? "freighter";
      setConnecting(true);
      setWalletError(null);
      setNetworkMismatch(null);
      try {
        const connector = createWalletConnector(id, scope);
        const connection = await connector.connect();
        const mismatch = detectNetworkMismatch(connection.network.passphrase, NETWORK.passphrase, {
          targetNetwork: NETWORK.name,
          walletNetwork: connection.network.name,
        });
        if (mismatch) {
          // The session stays unconnected on purpose. A wallet on another
          // network can be *read* with, but a signature it produces is for a
          // different transaction id, so offering it would be offering a
          // guaranteed failure.
          connectorRef.current = null;
          setWallet(null);
          setNetworkMismatch(mismatch);
          return;
        }
        connectorRef.current = connector;
        setProviderId(id);
        savePreferredProvider(id);
        setWallet({
          address: connection.address,
          networkPassphrase: connection.network.passphrase,
          network: connection.network.name,
        });
      } catch (error) {
        connectorRef.current = null;
        setWallet(null);
        setWalletError(
          error instanceof WalletNotInstalledError
            ? `${error.message} Setup guide: ${error.guideUrl}`
            : error instanceof Error
              ? error.message
              : String(error),
        );
      } finally {
        setConnecting(false);
      }
    },
    [providerId, scope],
  );

  /**
   * Ask the connected wallet to switch to this dashboard's network.
   *
   * Only Freighter exposes a switch request; for any other wallet the outcome
   * is `unsupported`, and the panel falls back to telling the operator which
   * setting to change rather than pretending the button did something.
   */
  const switchNetwork = useCallback(async (): Promise<NetworkSwitchOutcome | null> => {
    const api = await loadFreighterNetworkApi(scope.freighterLoader);
    const outcome = await requestFreighterNetworkSwitch({
      api,
      targetPassphrase: NETWORK.passphrase,
      targetNetwork: NETWORK.name,
    });
    if (outcome.kind === "switched") {
      setNetworkMismatch(null);
      setWalletError(null);
      await connect("freighter");
    }
    return outcome;
  }, [scope, connect]);

  const disconnect = useCallback(() => {
    connectorRef.current = null;
    setWallet(null);
    setNetworkMismatch(null);
    tabSync.broadcast("WALLET_DISCONNECTED", { guard: guardRef.current });
  }, [tabSync]);

  const notifyTabs = useCallback(
    (type: TabSyncEventType, options?: { payload?: Record<string, unknown> }) => {
      tabSync.broadcast(type, {
        guard: guardRef.current,
        ...(options?.payload === undefined ? {} : { payload: options.payload }),
      });
    },
    [tabSync],
  );

  const signer = useCallback((): WalletSigner => {
    if (demo) {
      throw new Error(
        "Demo mode shows static fixture data, so writes are disabled. Unset " +
          "NEXT_PUBLIC_DEMO_MODE and drop ?demo=true to sign with a real wallet.",
      );
    }
    if (!wallet) {
      throw new Error(
        "This console is in observer mode: no admin wallet is connected, so nothing can be signed. " +
          "Connect the admin wallet to perform this action.",
      );
    }
    // The connector that opened the session signs with it. The Freighter
    // fallback covers the silent reconnect on page load, where an address was
    // read from an already-authorized extension without a connector being built.
    const connector = connectorRef.current;
    if (connector) return connectorSigner(connector, wallet.address, NETWORK.passphrase);
    return freighterSigner(wallet.address, NETWORK.passphrase);
  }, [wallet, demo]);

  const refresh = useCallback(async () => {
    if (!guard) return;
    setRefreshing(true);
    try {
      // In demo mode the snapshot is a fixture, so no read (and no failure) is
      // possible; outside demo mode this is unchanged and always hits the chain.
      // The source account falls back to a known testnet address while
      // observing, because a read-only simulation needs a payer but is never
      // charged and mutates nothing.
      const next = demo
        ? demoSnapshot()
        : await readGuardSnapshot(server, guard, readSourceFor(wallet));
      setSnapshot(next);
      setSnapshotError(null);
    } catch (error) {
      // A transport failure is not the guard's state: report it as a failure and
      // drop the previous snapshot rather than leaving stale numbers on screen.
      setSnapshot(null);
      setSnapshotError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }, [guard, server, wallet, demo]);

  // The sync listener below is installed once, but `refresh` changes identity
  // with the guard and wallet, so it reaches it through a ref rather than
  // forcing a re-subscription (and a possible missed event) on every change.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // React to what the other tabs announce. Nothing crosses the wire as state:
  // `GUARD_CHANGED` carries an address to select, and the freeze/policy events
  // only prompt a re-read of the chain. Form drafts live in the panel's own
  // component state, so a remote refresh can never overwrite an edit in progress.
  useEffect(() => {
    return tabSync.subscribe((event) => {
      switch (event.type) {
        case "GUARD_CHANGED": {
          const next = event.guard;
          if (!next || next === guardRef.current) return;
          setGuard(next);
          setSnapshot(null);
          setSnapshotError(null);
          setEvents([]);
          seenRef.current = new Set();
          return;
        }
        case "FREEZE_STATE_CHANGED":
        case "POLICY_UPDATED":
          // Scope to the guard this tab is showing; an event about another
          // instance would only cause a pointless read.
          if (event.guard !== undefined && event.guard !== guardRef.current) return;
          void refreshRef.current();
          return;
        case "WALLET_DISCONNECTED":
          connectorRef.current = null;
          setWallet(null);
          setNetworkMismatch(null);
          return;
      }
    });
  }, [tabSync]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const selectGuard = useCallback(
    (next: string) => {
      setGuard(next);
      setSnapshot(null);
      setEvents([]);
      setRangeLabel(null);
      seenRef.current = new Set();
      // Every other tab follows the operator's selection instead of continuing to
      // poll a guard they are no longer looking at.
      tabSync.broadcast("GUARD_CHANGED", { guard: next });
    },
    [tabSync],
  );

  const addInstance = useCallback(
    (next: string, label: string) => {
      rememberInstance(next, label);
      setInstances(loadInstances());
      setGuard(next);
      setSnapshot(null);
      tabSync.broadcast("GUARD_CHANGED", { guard: next });
    },
    [tabSync],
  );

  const pushEvents = useCallback((incoming: GuardEvent[]) => {
    if (incoming.length === 0) return;
    // De-duplicate *before* the state update, never inside it: the updater has
    // to stay pure, because React StrictMode double-invokes updaters in
    // development and a `seenRef` mutation in the first pass would make the
    // second pass treat the whole batch as already known and drop it.
    const fresh = incoming.filter((event) => {
      const key = eventKey(event);
      if (seenRef.current.has(key)) return false;
      seenRef.current.add(key);
      return true;
    });
    if (fresh.length === 0) return;
    // Newest first, and bounded: the feed is a live view, not an archive.
    setEvents((current) => [...fresh, ...current].slice(0, 250));
  }, []);

  // Benchmark seam (issue #114): the perf spec streams thousands of synthetic
  // events through the feed at a controlled rate instead of waiting on the 5s
  // poll cadence, so FPS and heap growth can be measured under sustained load.
  // It is the same `pushEvents` the diagnostic path uses — no second write
  // route — and it is stripped from production builds, where the only events
  // are the ones actually polled from the chain.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const target = window as typeof window & {
      __guardFeedInject?: (incoming: GuardEvent[]) => void;
    };
    target.__guardFeedInject = pushEvents;
    return () => {
      delete target.__guardFeedInject;
    };
  }, [pushEvents]);

  const startWatching = useCallback(() => {
    if (!demo && (!feedRef.current || feedRef.current.guard !== guard)) {
      feedRef.current = new GuardFeed(server, guard);
    }
    setFeed((current) => ({ ...current, watching: true, error: null }));
  }, [guard, server, demo]);

  const stopWatching = useCallback(() => {
    setFeed((current) => ({ ...current, watching: false }));
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setRangeLabel(null);
    seenRef.current = new Set();
  }, []);

  // ── Historical range queries (#148) ──────────────────────────────────
  // The demo feed never touches RPC, so a demo-mode range query is answered
  // from the fixtures filtered by the same timestamps — the demo's honesty
  // note stays true and the picker still demonstrably works.
  const queryRange = useCallback(
    async (range: TimeRange, preset: RangePreset) => {
      const invalid = validateRange(range);
      if (invalid) {
        setFeed((current) => ({ ...current, error: invalid }));
        return;
      }
      const label =
        preset === "custom"
          ? `${new Date((range.fromUnixSecs ?? 0) * 1000).toLocaleString()} → ${
              range.toUnixSecs === null ? "now" : new Date(range.toUnixSecs * 1000).toLocaleString()
            }`
          : RANGE_PRESET_LABELS[preset];
      if (demo) {
        const from = range.fromUnixSecs ?? 0;
        const to = range.toUnixSecs ?? Number.MAX_SAFE_INTEGER;
        const inRange = demoEvents()
          .filter((event) => {
            if (!event.ledgerClosedAt) return false;
            const closedAt = Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000);
            return closedAt >= from && closedAt <= to;
          });
        setEvents(inRange);
        seenRef.current = new Set(inRange.map(eventKey));
        setRangeLabel(label);
        return;
      }
      const feedRunner =
        feedRef.current && feedRef.current.guard === guard
          ? feedRef.current
          : new GuardFeed(server, guard);
      if (feedRef.current !== feedRunner) feedRef.current = feedRunner;
      setFeed((current) => ({ ...current, error: null }));
      try {
        const page = await feedRunner.pollRange(range);
        setEvents(page.events);
        // seenRef is rebuilt so returning to the live tail does not re-suppress
        // rows this historical view already displayed.
        seenRef.current = new Set(page.events.map(eventKey));
        setRangeLabel(label);
      } catch (error) {
        setFeed((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [demo, guard, server],
  );

  // ── Operator session auto-lock ───────────────────────────────────────────
  // The countdown only runs while a wallet is connected: there is nothing to
  // lock until there is a signing session. On expiry the wallet is disconnected
  // and the in-memory event feed is dropped, so a walk-up cannot resume an
  // authorised session or read the last operator's diagnostics.
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(() => loadIdleTimeoutMs());
  const handleIdleExpire = useCallback(() => {
    disconnect();
    clearEvents();
  }, [disconnect, clearEvents]);
  const { state: idleState, stayConnected } = useIdleTimer({
    timeoutMs: idleTimeoutMs,
    enabled: wallet !== null,
    onExpire: handleIdleExpire,
  });
  const setIdleTimeout = useCallback((valueMs: number) => {
    saveIdleTimeoutMs(valueMs);
    setIdleTimeoutMs(valueMs);
  }, []);

  useEffect(() => {
    if (!feed.watching) return;

    // Demo mode generates its own event stream on a timer. It deliberately does
    // not construct a `GuardFeed`, so demo mode makes no RPC call at all.
    if (demo) {
      let demoCancelled = false;
      let sequence = 1;
      const emit = () => {
        if (demoCancelled) return;
        const event = syntheticDemoEvent(sequence, Date.now());
        sequence += 1;
        setEvents((current) => [event, ...current].slice(0, 250));
        setFeed((current) => ({
          ...current,
          latestLedger: DEMO_BASE_LEDGER + sequence,
          lastPolledAt: new Date().toISOString(),
          error: null,
        }));
      };
      const demoTimer = setInterval(emit, 4_000);
      return () => {
        demoCancelled = true;
        clearInterval(demoTimer);
      };
    }

    let cancelled = false;
    const tick = async () => {
      const feedRunner = feedRef.current;
      if (!feedRunner) return;
      try {
        const page = await feedRunner.pollOnce();
        if (cancelled) return;
        pushEvents(page.events);
        setFeed((current) => ({
          ...current,
          latestLedger: page.latestLedger,
          lastPolledAt: new Date().toISOString(),
          error: null,
        }));
      } catch (error) {
        if (cancelled) return;
        setFeed((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
          lastPolledAt: new Date().toISOString(),
        }));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), FEED_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [feed.watching, pushEvents, demo]);

  // Memoised so an `events` batch — the frequent update — cannot change this
  // object's identity and re-render every consumer that has nothing to do with
  // the feed. All fields below are the context's own deps.
  const value = useMemo<GuardContextValue>(
    () => ({
      server,
      wallet,
      walletError,
      connecting,
      connect,
      disconnect,
      signer,
      providerId,
      availableProviders,
      observer: isObserverSession(wallet),
      networkMismatch,
      switchNetwork,
      instances,
      guard,
      selectGuard,
      addInstance,
      snapshot,
      snapshotError,
      refreshing,
      refresh,
      feed,
      startWatching,
      stopWatching,
      clearEvents,
      pushEvents,
      queryRange,
      rangeLabel,
      notifyTabs,
      session: {
        state: idleState,
        timeoutMs: idleTimeoutMs,
        setTimeoutMs: setIdleTimeout,
        stayConnected,
      },
    }),
    [
      server,
      wallet,
      walletError,
      connecting,
      connect,
      disconnect,
      signer,
      providerId,
      availableProviders,
      networkMismatch,
      switchNetwork,
      instances,
      guard,
      selectGuard,
      addInstance,
      snapshot,
      snapshotError,
      refreshing,
      refresh,
      feed,
      startWatching,
      stopWatching,
      clearEvents,
      pushEvents,
      queryRange,
      rangeLabel,
      notifyTabs,
      idleState,
      idleTimeoutMs,
      setIdleTimeout,
      stayConnected,
    ],
  );

  return (
    <GuardContext.Provider value={value}>
      <GuardEventsContext.Provider value={events}>
        {children}
        {idleState.phase === "warning" && wallet && (
          <div className="modal-backdrop">
            <div
              className="modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="session-lock-title"
              aria-describedby="session-lock-body"
              tabIndex={-1}
            >
              <strong id="session-lock-title">
                Session expiring due to inactivity. Click to stay connected.
              </strong>
              <p className="tiny" id="session-lock-body">
                You will be disconnected in {idleState.secondsLeft}s. The admin wallet will be
                unlinked and unsaved work dropped; reconnecting is required before anything can be
                signed again.
              </p>
              <div className="row">
                <button onClick={stayConnected}>Stay connected</button>
              </div>
            </div>
          </div>
        )}
      </GuardEventsContext.Provider>
    </GuardContext.Provider>
  );
}

export function useGuard(): GuardContextValue {
  const value = useContext(GuardContext);
  if (!value) throw new Error("useGuard must be used inside <GuardProvider>");
  return value;
}

/** The live event feed, newest first — see `GuardEventsContext`. */
export function useGuardEvents(): GuardEvent[] {
  const value = useContext(GuardEventsContext);
  if (value === null) throw new Error("useGuardEvents must be used inside <GuardProvider>");
  return value;
}

export { eventKey, GuardContext, GuardEventsContext };
