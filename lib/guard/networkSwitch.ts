"use client";

/**
 * Detecting and fixing a wallet/dashboard network mismatch (issue #97).
 *
 * A Testnet guard address does not exist on Mainnet, and a signature made for
 * one network cannot authorize a transaction on the other — the passphrase is
 * part of the transaction id. So when the console is pointed at Testnet and
 * Freighter is showing Mainnet, the operator has two ways to find out: either
 * every write fails with an unhelpful `tx failed` deep inside Soroban, or the
 * dashboard says what it saw and offers the one action that fixes it.
 *
 * `wallet.ts` has always detected the mismatch on connect and refused to
 * proceed, which is the correct *signing* answer and a poor *operator* answer:
 * it names the problem and stops. This module keeps the refusal — the wallet is
 * still never used for signing while it disagrees — and adds the fix: ask
 * Freighter to switch networks through its API, and fall back to telling the
 * operator exactly which setting to change when the wallet declines, is
 * older than the request API, or was never a Freighter to begin with.
 *
 * The switch request is injectable for the same reason as the rest of the
 * guard library: the branch that matters for safety ("the operator said no, so
 * nothing is signed") has to be testable without a browser extension.
 */

import { NETWORK } from "./network.ts";
import { normalizeWalletNetwork, type FreighterApiModule } from "./walletConnector.ts";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const FUTURENET_PASSPHRASE = "Test SDF Future Network ; October 2022";

/** Names Freighter's own API accepts for `requestNetworkAccess`. */
const FREIGHTER_NETWORK_NAMES: Readonly<Record<string, string>> = {
  testnet: "testnet",
  public: "public",
  mainnet: "public",
  futurenet: "futurenet",
};

export interface NetworkMismatch {
  walletNetwork: string;
  walletPassphrase: string;
  targetNetwork: string;
  targetPassphrase: string;
}

/**
 * The mismatch, or null when the wallet can sign for this dashboard.
 *
 * An empty or unknown wallet passphrase counts as a mismatch: the alternative
 * is treating "we could not tell" as "we agree", which is precisely the
 * assumption that produces a signature over the wrong network id.
 */
export function detectNetworkMismatch(
  walletPassphrase: string | null | undefined,
  targetPassphrase: string = NETWORK.passphrase,
  options: { targetNetwork?: string; walletNetwork?: string | null } = {},
): NetworkMismatch | null {
  const observed = (walletPassphrase ?? "").trim();
  if (observed && observed === targetPassphrase) return null;
  return {
    walletNetwork: options.walletNetwork || normalizeWalletNetwork({ passphrase: observed, name: null }).name,
    walletPassphrase: observed,
    targetNetwork: options.targetNetwork ?? NETWORK.name,
    targetPassphrase,
  };
}

/** Resolve a passphrase (or a bare name) into the word an operator recognises. */
export function networkDisplayName(value: {
  passphrase: string | null | undefined;
  name?: string | null;
}): string {
  const normalized = normalizeWalletNetwork({
    passphrase: value.passphrase ?? null,
    name: value.name ?? null,
  });
  switch (normalized.name) {
    case "public":
      return "Mainnet";
    case "testnet":
      return "Testnet";
    case "futurenet":
      return "Futurenet";
    case "standalone":
      return "Standalone";
    case "unknown":
    case "":
      return "an unknown network";
    default:
      return capitalize(normalized.name);
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The warning bar's headline, in the words the issue specifies.
 *
 * Built from the observed network rather than a fixed "Mainnet" string: the
 * mismatch also happens in the other direction, and an operator who is on
 * Futurenet does not want to be told they are on Mainnet.
 */
export function describeMismatch(mismatch: NetworkMismatch): string {
  return `Wallet on ${networkDisplayName({
    passphrase: mismatch.walletPassphrase,
    name: mismatch.walletNetwork,
  })}, dashboard on ${networkDisplayName({
    passphrase: mismatch.targetPassphrase,
    name: mismatch.targetNetwork,
  })}.`;
}

export function mismatchExplanation(mismatch: NetworkMismatch): string {
  return (
    `A signature produced for ${describeTarget(mismatch)} cannot authorize a call on ` +
    `${describeDashboard(mismatch)}, so nothing has been sent and no write can be signed ` +
    `until the wallet agrees. Switch the wallet's network, or change this console's target.`
  );
}

function describeTarget(mismatch: NetworkMismatch): string {
  return networkDisplayName({ passphrase: mismatch.walletPassphrase, name: mismatch.walletNetwork });
}

function describeDashboard(mismatch: NetworkMismatch): string {
  return networkDisplayName({
    passphrase: mismatch.targetPassphrase,
    name: mismatch.targetNetwork,
  });
}

/** The button label, phrased so it is obvious the wallet is the thing that changes. */
export function switchButtonLabel(mismatch: NetworkMismatch): string {
  return `Switch wallet to ${describeDashboard(mismatch)}`;
}

/**
 * What to do when the API cannot help.
 *
 * The manual path is not a consolation message — it is the only correct answer
 * for Albedo and xBull, whose network selection lives in their own UI, and for
 * a Freighter build old enough not to expose the request API.
 */
export function manualSwitchInstructions(mismatch: NetworkMismatch): string[] {
  return [
    `Open your wallet and switch it to ${describeDashboard(mismatch)}.`,
    `In Freighter: click the network chip at the top of the popup and choose ${describeDashboard(mismatch)}.`,
    `Reconnect once the wallet shows ${describeDashboard(mismatch)} — the console re-checks it on connect.`,
  ];
}

// ── The switch request ─────────────────────────────────────────────────────

export type NetworkSwitchOutcome =
  | { kind: "switched"; network: string; passphrase: string }
  | { kind: "already"; network: string; passphrase: string }
  | { kind: "declined"; message: string }
  | { kind: "unsupported"; message: string }
  | { kind: "failed"; message: string };

export interface NetworkSwitchRequest {
  network: string;
}

export interface FreighterNetworkApi {
  requestNetworkAccess?(request: NetworkSwitchRequest): Promise<NetworkSwitchReply | undefined | void>;
  getNetworkDetails(): Promise<{ network?: string; networkPassphrase?: string; error?: unknown }>;
}

export type NetworkSwitchReply =
  | { isChanged?: boolean; isError?: boolean; error?: string | null; message?: string | null }
  | undefined
  | null
  | void;

/**
 * Ask Freighter to move to the target network.
 *
 * The reply is not trusted on its own. Freighter's `isError` predates the
 * `isChanged` field and some builds return neither, so the confirmation is the
 * network the wallet reports *after* the request — the only reading that
 * matches what the operator actually sees in the popup.
 */
export async function requestFreighterNetworkSwitch(options: {
  api: FreighterNetworkApi | null;
  targetPassphrase?: string;
  targetNetwork?: string;
}): Promise<NetworkSwitchOutcome> {
  const targetPassphrase = options.targetPassphrase ?? NETWORK.passphrase;
  const targetNetwork = options.targetNetwork ?? NETWORK.name;
  const api = options.api;
  if (!api) {
    return {
      kind: "unsupported",
      message: "Freighter's network API is not reachable from this page.",
    };
  }
  if (typeof api.requestNetworkAccess !== "function") {
    return {
      kind: "unsupported",
      message:
        "This Freighter build does not expose a network-switch request, so the change has to be made in the wallet itself.",
    };
  }

  const requested = FREIGHTER_NETWORK_NAMES[targetNetwork.toLowerCase()] ?? targetNetwork.toLowerCase();
  let reply: NetworkSwitchReply;
  try {
    reply = await api.requestNetworkAccess({ network: requested });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: classifySwitchFailure(message), message };
  }

  const denied = readReplyError(reply);
  if (denied) return { kind: classifySwitchFailure(denied), message: denied };

  try {
    const details = await api.getNetworkDetails();
    const passphrase = (details.networkPassphrase ?? "").trim();
    if (passphrase === targetPassphrase) {
      return { kind: "switched", network: details.network ?? targetNetwork, passphrase };
    }
    // No error, and still the wrong network: the operator dismissed the prompt.
    return {
      kind: "declined",
      message: `Freighter is still on ${networkDisplayName({
        passphrase,
        name: details.network,
      })}. The switch request was not approved.`,
    };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function readReplyError(reply: NetworkSwitchReply): string | null {
  if (!reply || typeof reply !== "object") return null;
  const record = reply as { isError?: boolean; error?: string | null; message?: string | null };
  if (record.isError) return record.error || record.message || "Freighter refused the network change.";
  if (typeof record.error === "string" && record.error) return record.error;
  return null;
}

/**
 * Separate "the operator said no" from "something broke".
 *
 * It matters because the two need different follow-ups: one is "click Allow and
 * try again", the other is "check your wallet install", and reporting a
 * declined request as a failure teaches the operator to distrust the button.
 */
export function classifySwitchFailure(message: string): "declined" | "failed" {
  return /reject|denied|declin|cancel|abort|dismiss/i.test(message) ? "declined" : "failed";
}

/** The outcome phrased for the panel: what happened, and what to do next. */
export function describeSwitchOutcome(outcome: NetworkSwitchOutcome): {
  tone: "ok" | "warn" | "danger";
  text: string;
} {
  switch (outcome.kind) {
    case "switched":
      return {
        tone: "ok",
        text: `The wallet is now on ${networkDisplayName({
          passphrase: outcome.passphrase,
          name: outcome.network,
        })}. Reconnect to resume signing.`,
      };
    case "already":
      return { tone: "ok", text: "The wallet was already on the right network." };
    case "declined":
      return { tone: "warn", text: `${outcome.message} Nothing was signed.` };
    case "unsupported":
      return { tone: "warn", text: outcome.message };
    case "failed":
      return { tone: "danger", text: `The wallet could not switch networks: ${outcome.message}` };
  }
}

/** Load Freighter's API through the injected loader, swallowing a missing extension. */
export async function loadFreighterNetworkApi(
  loader: (() => Promise<FreighterApiModule>) | null,
): Promise<FreighterNetworkApi | null> {
  if (!loader) return null;
  try {
    return (await loader()) as unknown as FreighterNetworkApi;
  } catch {
    return null;
  }
}
