"use client";

import { useState } from "react";
import { useGuard } from "./GuardProvider.tsx";
import { AddressText, ErrorBlock, short, useAddressLabel } from "./bits.tsx";
import { AddressBookModal } from "./AddressBookModal.tsx";
import { looksLikeContractAddress } from "../lib/guard/instance.ts";
import { IDLE_TIMEOUT_OPTIONS } from "../lib/guard/useIdleTimer.ts";
import {
  WALLET_PROVIDERS,
  walletProviderDescriptor,
  type WalletProviderId,
} from "../lib/guard/walletConnector.ts";
import {
  describeMismatch,
  describeSwitchOutcome,
  manualSwitchInstructions,
  mismatchExplanation,
  switchButtonLabel,
  type NetworkSwitchOutcome,
} from "../lib/guard/networkSwitch.ts";
import { OBSERVER_BADGE_LABEL, WRITE_DISABLED_HINT } from "../lib/guard/observerMode.ts";

export function WalletBar() {
  const {
    wallet,
    walletError,
    connecting,
    connect,
    disconnect,
    instances,
    guard,
    selectGuard,
    addInstance,
    session,
    providerId,
    availableProviders,
    observer,
    networkMismatch,
    switchNetwork,
  } = useGuard();
  const [newAddress, setNewAddress] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [bookOpen, setBookOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switchOutcome, setSwitchOutcome] = useState<NetworkSwitchOutcome | null>(null);

  const selected = instances.find((instance) => instance.guard === guard);
  const guardNickname = useAddressLabel(guard);
  const provider = providerId ? walletProviderDescriptor(providerId) : null;

  return (
    <div className="panel">
      <div className="split">
        <div>
          <label className="field">
            <span className="lbl">Guarded account (the smart account being operated)</span>
            <select value={guard} onChange={(event) => selectGuard(event.target.value)}>
              {instances.map((instance) => (
                <option key={instance.guard} value={instance.guard}>
                  {instance.label} — {short(instance.guard, 8, 6)}
                </option>
              ))}
            </select>
            <span className="hint">
              {selected?.provenance}
              {guardNickname ? ` · in your address book as “${guardNickname}”` : ""}
            </span>
          </label>
          <div className="row">
            <input
              value={newAddress}
              onChange={(event) => {
                setNewAddress(event.target.value);
                setAddError(null);
              }}
              placeholder="Add a guard contract address (C…)"
              aria-label="Guard contract address"
            />
            <button
              className="secondary"
              onClick={() => {
                const candidate = newAddress.trim();
                if (!looksLikeContractAddress(candidate)) {
                  setAddError("That is not a Soroban contract address (52 characters, starting with C).");
                  return;
                }
                addInstance(candidate, `Guard ${short(candidate, 6, 4)}`);
                setNewAddress("");
              }}
            >
              Add
            </button>
          </div>
          {addError && <ErrorBlock title="Could not add that instance" detail={addError} />}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={() => setBookOpen(true)}>
              Address book
            </button>
            <span className="tiny muted">Name the addresses you operate.</span>
          </div>
        </div>

        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="lbl muted" style={{ fontSize: 12.5 }}>
              Admin wallet
            </span>
            {/* The observer label is the console admitting what it cannot do,
                which is the difference between a read-only view and a broken one. */}
            {observer && (
              <span className="pill warn" data-testid="observer-badge" title={WRITE_DISABLED_HINT}>
                {OBSERVER_BADGE_LABEL}
              </span>
            )}
          </div>
          <div className="row" style={{ marginTop: 5 }}>
            {wallet ? (
              <>
                <span className="pill ok">connected</span>
                {provider && <span className="pill">{provider.name}</span>}
                <AddressText address={wallet.address} />
                <button className="secondary" onClick={() => setPickerOpen(true)} disabled={connecting}>
                  Change wallet
                </button>
                <button className="secondary" onClick={disconnect}>
                  Disconnect
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setPickerOpen(true)} disabled={connecting}>
                  {connecting ? "Waiting for wallet…" : "Connect admin wallet"}
                </button>
                {!connecting && <span className="tiny muted">Reading stays available.</span>}
              </>
            )}
          </div>

          {networkMismatch && (
            <div className="notice warn" role="alert" data-testid="network-mismatch">
              <strong>{describeMismatch(networkMismatch)}</strong>
              <span className="tiny">{mismatchExplanation(networkMismatch)}</span>
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => void switchNetwork().then(setSwitchOutcome)}>
                  {switchButtonLabel(networkMismatch)}
                </button>
              </div>
              {switchOutcome && (
                <div className="tiny" data-testid="switch-outcome" style={{ marginTop: 6 }}>
                  {describeSwitchOutcome(switchOutcome).text}
                </div>
              )}
              {switchOutcome && switchOutcome.kind !== "switched" && (
                <ul className="tiny muted" style={{ marginTop: 6 }}>
                  {manualSwitchInstructions(networkMismatch).map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="tiny muted" style={{ marginTop: 8 }}>
            Every write on this page is signed inside {provider ? provider.name : "your wallet"} and
            broadcast straight to Soroban RPC. The console never sees, stores or transmits a secret
            key, and there is no server component that could hold one.
          </p>
          <label className="field" style={{ marginTop: 8 }}>
            <span className="lbl">Auto-lock after inactivity</span>
            <select
              value={String(session.timeoutMs)}
              onChange={(event) => session.setTimeoutMs(Number(event.target.value))}
            >
              {IDLE_TIMEOUT_OPTIONS.map((option) => (
                <option key={option.valueMs} value={String(option.valueMs)}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="hint">
              {session.timeoutMs === 0
                ? "The session will not lock automatically."
                : `The wallet disconnects after ${Math.round(session.timeoutMs / 60000)} minute(s) of inactivity, with a 60s warning first.`}
            </span>
          </label>
          {walletError && <ErrorBlock title="Wallet connection" detail={walletError} />}
        </div>
      </div>

      {bookOpen && <AddressBookModal onClose={() => setBookOpen(false)} />}
      {pickerOpen && (
        <WalletPickerModal
          availableProviders={availableProviders}
          currentProvider={providerId}
          connecting={connecting}
          onClose={() => setPickerOpen(false)}
          onChoose={(id) => {
            setPickerOpen(false);
            void connect(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * The wallet selection modal (issue #96).
 *
 * Providers the browser did not detect are listed rather than hidden, because
 * hiding them leaves an operator with no path forward — each one is labelled
 * with where to get it, and choosing it still attempts the connection so a
 * wallet the probe missed (a permission-restricted browser, a second profile)
 * is not unfairly written off.
 */
export function WalletPickerModal({
  availableProviders,
  currentProvider,
  connecting,
  onClose,
  onChoose,
}: {
  availableProviders: WalletProviderId[];
  currentProvider: WalletProviderId | null;
  connecting: boolean;
  onClose: () => void;
  onChoose: (provider: WalletProviderId) => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <strong id="wallet-picker-title">Choose a wallet provider</strong>
        <p className="tiny muted">
          Any of these can sign for a guard. The console remembers which one you use.
        </p>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          {WALLET_PROVIDERS.map((descriptor) => {
            const detected = availableProviders.includes(descriptor.id);
            const isCurrent = descriptor.id === currentProvider;
            return (
              <div key={descriptor.id} className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <span className="pill" aria-hidden="true">
                    {descriptor.monogram}
                  </span>{" "}
                  <strong>{descriptor.name}</strong>
                  {isCurrent && <span className="pill ok"> current</span>}
                  <div className="tiny muted">{descriptor.blurb}</div>
                </div>
                <div className="row">
                  {detected ? (
                    <span className="pill ok tiny">detected</span>
                  ) : (
                    <a
                      className="tiny"
                      href={descriptor.installUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={`Install ${descriptor.name}`}
                    >
                      not detected — get {descriptor.name}
                    </a>
                  )}
                  <button disabled={connecting} onClick={() => onChoose(descriptor.id)}>
                    {detected ? "Connect" : "Try anyway"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <span className="tiny muted">
            Or keep observing — every read on this page works without a wallet.
          </span>
        </div>
      </div>
    </div>
  );
}
