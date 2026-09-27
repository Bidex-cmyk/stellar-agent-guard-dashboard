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
import { connectWallet, currentAddress, freighterSigner, type ConnectedWallet } from "../lib/guard/wallet.ts";
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

const SNAPSHOT_INTERVAL_MS = 15_000;
const FEED_INTERVAL_MS = 5_000;

interface GuardContextValue {
  server: rpc.Server;
  wallet: ConnectedWallet | null;
  walletError: string | null;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** A signer for the connected wallet, or a thrown error explaining why not. */
  signer: () => WalletSigner;
  instances: GuardInstance[];
  guard: string;
  selectGuard: (guard: string) => void;
  addInstance: (guard: string, label: string) => void;
  snapshot: GuardSnapshot | null;
  snapshotError: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  events: GuardEvent[];
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

/** A stable identity for an event, so re-polling the same page cannot duplicate rows. */
function eventKey(event: GuardEvent): string {
  return [
    event.source,
    event.transactionHash ?? "-",
    event.ledger ?? "-",
    event.topic,
    event.decision?.result ?? "-",
    event.decision?.reason ?? "-",
    typeof event.data === "object" && event.data !== null ? JSON.stringify(event.data) : String(event.data),
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

  // Pick up an already-authorized wallet without prompting for access again.
  useEffect(() => {
    if (demo) return;
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

  const connect = useCallback(async () => {
    setConnecting(true);
    setWalletError(null);
    try {
      const connected = await connectWallet();
      if (connected.networkPassphrase !== NETWORK.passphrase) {
        setWallet(null);
        setWalletError(
          `Your wallet is on "${connected.network}", but this dashboard is configured for ` +
            `"${NETWORK.name}". A signature produced for a different network cannot authorize ` +
            `a call on this one, so nothing was sent. Switch the wallet's network and reconnect.`,
        );
        return;
      }
      setWallet(connected);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setWallet(null);
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
    if (!wallet) throw new Error("Connect a wallet before signing anything.");
    return freighterSigner(wallet.address, NETWORK.passphrase);
  }, [wallet, demo]);

  const refresh = useCallback(async () => {
    if (!guard) return;
    setRefreshing(true);
    try {
      // In demo mode the snapshot is a fixture, so no read (and no failure) is
      // possible; outside demo mode this is unchanged and always hits the chain.
      const next = demo ? demoSnapshot() : await readGuardSnapshot(server, guard, wallet?.address);
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
  }, [guard, server, wallet?.address, demo]);

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
          setWallet(null);
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
    setEvents((current) => {
      const fresh = incoming.filter((event) => {
        const key = eventKey(event);
        if (seenRef.current.has(key)) return false;
        seenRef.current.add(key);
        return true;
      });
      if (fresh.length === 0) return current;
      // Newest first, and bounded: the feed is a live view, not an archive.
      return [...fresh, ...current].slice(0, 250);
    });
  }, []);

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
    seenRef.current = new Set();
  }, []);

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

  const value: GuardContextValue = {
    server,
    wallet,
    walletError,
    connecting,
    connect,
    disconnect,
    signer,
    instances,
    guard,
    selectGuard,
    addInstance,
    snapshot,
    snapshotError,
    refreshing,
    refresh,
    events,
    feed,
    startWatching,
    stopWatching,
    clearEvents,
    pushEvents,
    notifyTabs,
    session: {
      state: idleState,
      timeoutMs: idleTimeoutMs,
      setTimeoutMs: setIdleTimeout,
      stayConnected,
    },
  };

  return (
    <GuardContext.Provider value={value}>
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
    </GuardContext.Provider>
  );
}

export function useGuard(): GuardContextValue {
  const value = useContext(GuardContext);
  if (!value) throw new Error("useGuard must be used inside <GuardProvider>");
  return value;
}

export { eventKey, GuardContext };
