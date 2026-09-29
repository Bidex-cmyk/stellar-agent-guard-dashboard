/**
 * Testnet funding for the accounts a deploy needs.
 *
 * A freshly generated agent keypair starts with zero XLM, so it cannot pay the
 * transaction fee for its own heartbeats and the guard silently stops
 * enforcing. SDF runs a Friendbot on Testnet and Futurenet that pays out to any
 * account on request; Mainnet has no such service, and a private network's
 * faucet is not something this dashboard can assume.
 *
 * The dashboard has no server half, so every request here is built as data and
 * executed by a `fetch` the caller injects. That keeps address validation,
 * balance parsing and error wording testable without a network, and keeps the
 * one place that touches the wire out of the logic.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";

/** Below this, an account cannot reliably pay for its own next transaction. */
export const FUNDING_THRESHOLD_XLM = "1";

export interface NetworkSignals {
  rpcUrl?: string;
  horizonUrl?: string;
  passphrase?: string;
}

/** A network this dashboard is willing to fund against, or why it is not. */
export type FriendbotTarget =
  | {
      supported: true;
      network: "testnet" | "futurenet";
      label: string;
      horizonUrl: string;
      friendbotUrl: string;
    }
  | { supported: false; reason: string };

const TESTNET: Omit<Extract<FriendbotTarget, { supported: true }>, "supported"> = {
  network: "testnet",
  label: "Testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
};

const FUTURENET: Omit<Extract<FriendbotTarget, { supported: true }>, "supported"> = {
  network: "futurenet",
  label: "Futurenet",
  horizonUrl: "https://horizon-futurenet.stellar.org",
  friendbotUrl: "https://friendbot-futurenet.stellar.org",
};

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/**
 * Decide whether the connected network can be funded, from whichever endpoints
 * the caller happens to know.
 *
 * Matching is on the host and the passphrase rather than a config flag, because
 * the dashboard pins one network today (`NETWORK` in `network.ts`) and an
 * operator pointing it somewhere else should get an honest "not supported"
 * rather than a Friendbot call against a network that has no faucet.
 */
export function friendbotTarget(signals: NetworkSignals = {}): FriendbotTarget {
  const rpcUrl = (signals.rpcUrl ?? NETWORK.rpcUrl).toLowerCase();
  const horizonUrl = (signals.horizonUrl ?? "").toLowerCase();
  const passphrase = signals.passphrase ?? NETWORK.passphrase;

  if (rpcUrl.includes("mainnet") || horizonUrl.includes("mainnet") || passphrase === MAINNET_PASSPHRASE) {
    return {
      supported: false,
      reason: "Mainnet has no Friendbot: fund the account from an exchange instead.",
    };
  }
  if (rpcUrl.includes("futurenet") || horizonUrl.includes("futurenet") || passphrase.toLowerCase().includes("future")) {
    return { supported: true, ...FUTURENET };
  }
  if (
    rpcUrl.includes("soroban-testnet.stellar.org") ||
    horizonUrl.includes("horizon-testnet.stellar.org") ||
    passphrase === NETWORK.passphrase
  ) {
    return { supported: true, ...TESTNET };
  }
  return {
    supported: false,
    reason: `This network is not a public SDF test network, so there is no faucet to call (${passphrase}).`,
  };
}

/**
 * A G... account id, checked against the real strkey rules.
 *
 * Decoded rather than pattern-matched: the base32 alphabet omits I, L, O and U,
 * and the trailing characters are a checksum, so an address can look right and
 * still be a typo. Horizon and Friendbot would both refuse it later.
 */
export function isAccountId(value: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(value.trim().toUpperCase());
  } catch {
    return false;
  }
}

function requireAccountId(address: string, what: string): string {
  const trimmed = address.trim();
  if (!isAccountId(trimmed)) throw new Error(`${what} is not a valid account address: ${address}`);
  return trimmed.toUpperCase();
}

export interface JsonRequest {
  url: string;
  init: { headers: Record<string, string> };
}

/** Horizon's account record, which carries the XLM balance. */
export function buildBalanceRequest(address: string, horizonUrl: string): JsonRequest {
  const account = requireAccountId(address, "Account");
  return {
    url: `${trimTrailingSlash(horizonUrl)}/accounts/${account}`,
    init: { headers: { Accept: "application/json" } },
  };
}

/** Friendbot's payout endpoint: a GET with the address as a query parameter. */
export function buildFundRequest(address: string, friendbotUrl: string): JsonRequest {
  const account = requireAccountId(address, "Account");
  return {
    url: `${trimTrailingSlash(friendbotUrl)}/?addr=${encodeURIComponent(account)}`,
    init: { headers: { Accept: "application/json" } },
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** What one account looks like when asked. */
export type AccountState =
  | { state: "funded"; balanceXlm: string }
  | { state: "unfunded"; balanceXlm: string }
  | { state: "absent"; balanceXlm: null }
  | { state: "unreachable"; balanceXlm: null; detail: string };

/**
 * Read the native balance out of a Horizon account payload.
 *
 * Anything the payload does not clearly say is treated as unknown rather than
 * as zero: an operator who is told "unfunded" on a malformed response may fund
 * an account that already has plenty, and the warning that matters most — "this
 * agent cannot pay for heartbeats" — has to be trustworthy.
 */
export function parseAccountPayload(
  payload: unknown,
  thresholdXlm: string = FUNDING_THRESHOLD_XLM,
): AccountState {
  const balances = (payload as { balances?: unknown })?.balances;
  if (!Array.isArray(balances)) {
    return { state: "unreachable", balanceXlm: null, detail: "no balance list in the response" };
  }
  const native = balances.find(
    (entry) => (entry as { asset_type?: unknown })?.asset_type === "native",
  ) as { balance?: unknown } | undefined;
  if (!native || typeof native.balance !== "string") {
    return { state: "unreachable", balanceXlm: null, detail: "account has no native balance entry" };
  }
  const balanceXlm = native.balance;
  if (!/^\d+(\.\d+)?$/.test(balanceXlm)) {
    return { state: "unreachable", balanceXlm: null, detail: `unreadable balance: ${balanceXlm}` };
  }
  // Compared as scaled integers, because a float comparison on "0.9999999"
  // versus "1" is where these checks usually go wrong.
  const below = scaleXlm(balanceXlm) < scaleXlm(thresholdXlm);
  return below ? { state: "unfunded", balanceXlm } : { state: "funded", balanceXlm };
}

function scaleXlm(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const padded = (fraction + "0000000").slice(0, 7);
  return BigInt(whole ?? "0") * 10_000_000n + BigInt(padded || "0");
}

/** Turn a balance response into an account state, including the 404 case. */
export function interpretBalanceResponse(status: number, payload: unknown): AccountState {
  if (status === 404) return { state: "absent", balanceXlm: null };
  if (status < 200 || status >= 300) {
    return { state: "unreachable", balanceXlm: null, detail: `Horizon responded ${status}` };
  }
  return parseAccountPayload(payload);
}

export interface FundOutcome {
  ok: boolean;
  message: string;
  hash: string | null;
}

/**
 * Friendbot's answer, in operator's terms.
 *
 * A successful payout is a 200 carrying the transaction hash; the failures the
 * dashboard actually sees are a rate limit, an unfundable base reserve, and
 * Friendbot's own 500s, whose body is a JSON error or a bare sentence depending
 * on which upstream failed.
 */
export function interpretFundResponse(status: number, body: string): FundOutcome {
  const hash = extractHash(body);
  if (status >= 200 && status < 300 && hash) {
    return { ok: true, message: "Funded.", hash };
  }
  if (status >= 200 && status < 300) {
    return { ok: true, message: "Friendbot accepted the request.", hash: null };
  }
  const detail = extractErrorDetail(body);
  if (status === 429) {
    return { ok: false, message: `Faucet rate limit reached${detail ? `: ${detail}` : ""}; try again in a minute.`, hash: null };
  }
  if (status === 400) {
    return { ok: false, message: `Friendbot refused this address${detail ? `: ${detail}` : ""}.`, hash: null };
  }
  return { ok: false, message: `Friendbot failed (HTTP ${status})${detail ? `: ${detail}` : ""}.`, hash: null };
}

function extractHash(body: string): string | null {
  const direct = /"hash"\s*:\s*"([0-9a-fA-F]{64})"/.exec(body);
  if (direct?.[1]) return direct[1];
  const bare = /^([0-9a-fA-F]{64})\s*$/.exec(body.trim());
  return bare?.[1] ?? null;
}

function extractErrorDetail(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const detail = /"(?:detail|error|title)"\s*:\s*"([^"]+)"/.exec(trimmed);
  if (detail?.[1]) return detail[1];
  if (trimmed.startsWith("{")) return null;
  return trimmed.slice(0, 160);
}

/** The shape of `fetch` this module needs, so tests can hand in a fake. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface BalanceReading {
  address: string;
  state: AccountState;
}

/** Ask Horizon about each address; one failing account must not hide the others. */
export async function probeBalances(
  addresses: readonly string[],
  target: Extract<FriendbotTarget, { supported: true }>,
  fetchImpl: FetchLike,
): Promise<BalanceReading[]> {
  const readings: BalanceReading[] = [];
  for (const address of addresses) {
    if (!address.trim()) continue;
    readings.push({ address: address.trim(), state: await probeBalance(address, target, fetchImpl) });
  }
  return readings;
}

export async function probeBalance(
  address: string,
  target: Extract<FriendbotTarget, { supported: true }>,
  fetchImpl: FetchLike,
): Promise<AccountState> {
  const request = buildBalanceRequest(address, target.horizonUrl);
  try {
    const response = await fetchImpl(request.url, request.init);
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return interpretBalanceResponse(response.status, payload);
  } catch (caught) {
    return {
      state: "unreachable",
      balanceXlm: null,
      detail: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

export interface FundingResult {
  address: string;
  ok: boolean;
  message: string;
}

/** Fund each address in order, reporting each result rather than throwing. */
export async function fundWithFriendbot(
  addresses: readonly string[],
  target: Extract<FriendbotTarget, { supported: true }>,
  fetchImpl: FetchLike,
  onEach?: (result: FundingResult) => void,
): Promise<FundingResult[]> {
  const results: FundingResult[] = [];
  for (const address of addresses) {
    const trimmed = address.trim();
    if (!trimmed) continue;
    let result: FundingResult;
    try {
      const request = buildFundRequest(trimmed, target.friendbotUrl);
      const response = await fetchImpl(request.url, request.init);
      const body = await response.text();
      const outcome = interpretFundResponse(response.status, body);
      result = { address: trimmed, ok: outcome.ok, message: outcome.message };
    } catch (caught) {
      result = {
        address: trimmed,
        ok: false,
        message: caught instanceof Error ? caught.message : String(caught),
      };
    }
    results.push(result);
    onEach?.(result);
  }
  return results;
}

/** How the dashboard should word the funding summary for a set of readings. */
export function describeBalances(readings: readonly BalanceReading[]): string {
  if (readings.length === 0) return "No account to check yet.";
  const parts = readings.map((reading) => {
    const short = `${reading.address.slice(0, 5)}…${reading.address.slice(-4)}`;
    switch (reading.state.state) {
      case "funded":
        return `${short} holds ${reading.state.balanceXlm} XLM`;
      case "unfunded":
        return `${short} has ${reading.state.balanceXlm} XLM, below the 1 XLM reserve`;
      case "absent":
        return `${short} does not exist on chain yet`;
      case "unreachable":
        return `${short} could not be read (${reading.state.detail})`;
    }
    return short;
  });
  return parts.join(" · ");
}

/** True when anything in the set needs funding. */
export function needsFunding(readings: readonly BalanceReading[]): boolean {
  return readings.some((reading) => reading.state.state === "unfunded" || reading.state.state === "absent");
}
