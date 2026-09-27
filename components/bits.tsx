"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ReadResult } from "../lib/guard/chain.ts";
import { ENFORCEMENT_SCOPE_STATEMENT } from "../lib/guard/network.ts";
import { lookupLabel, subscribeAddressBook } from "../lib/guard/addressBook.ts";
import {
  formatRawStroops,
  formatStroopsWithUnit,
  type FormatStroopsOptions,
} from "../lib/guard/formatters.ts";

export function Tabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/", label: "Console" },
    { href: "/fleet", label: "Fleet" },
    { href: "/configure", label: "Configure" },
  ];
  return (
    <nav className="tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The enforcement boundary, shown wherever a capability is described.
 *
 * Rendered from the same constant the README and SPEC.md quote, so the interface
 * cannot end up claiming more (or less) than the documents do.
 */
export function ScopeNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div className="notice">
      <strong>What the policy engine enforces</strong>
      <span className="tiny">{ENFORCEMENT_SCOPE_STATEMENT}</span>
      {!compact && (
        <div className="tiny muted" style={{ marginTop: 6 }}>
          This boundary is a property of the platform, not a gap this interface hides.
        </div>
      )}
    </div>
  );
}

export function ErrorBlock({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="error">
      <span className="t">{title}</span>
      <span className="mono">{detail}</span>
    </div>
  );
}

/**
 * Render a read's value, or its failure.
 *
 * There is no third branch on purpose: a read that did not succeed has no value
 * to show, and substituting a zero would make an outage indistinguishable from a
 * genuinely empty policy.
 */
export function Read<T>({
  result,
  label,
  render,
}: {
  result: ReadResult<T>;
  label: string;
  render: (value: T) => ReactNode;
}) {
  if (!result.ok) return <ErrorBlock title={`${label}: read failed`} detail={result.error} />;
  return <>{render(result.value)}</>;
}

export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className={`v${tone ? ` ${tone}` : ""}`} style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      {note !== undefined && <div className="n">{note}</div>}
    </div>
  );
}

export function short(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * The operator's nickname for an address, or `null` when it is not in the book.
 *
 * Resolves to `null` during server render (there is no `localStorage` to read)
 * and again on the first client render, then settles once mounted, so it never
 * causes a hydration mismatch — an unlabelled address looks identical on both.
 * It re-reads whenever the book changes anywhere in the tab.
 */
export function useAddressLabel(address: string): string | null {
  // Always start `null` — the same on server and client's first render — then
  // resolve from the book in an effect. Reading `localStorage` during the first
  // render would desynchronise hydration whenever an address happens to be
  // labelled.
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setLabel(lookupLabel(address));
    refresh();
    return subscribeAddressBook(refresh);
  }, [address]);
  return label;
}

/**
 * Render an address the way an operator reads it: `Nickname (XXXX…YYYY)` when it
 * is in the address book, otherwise the bare truncated form. The full address
 * stays on `title` so nothing is lost — the nickname is a convenience over the
 * real key, never a replacement for it.
 */
export function AddressText({
  address,
  className,
}: {
  address: string;
  className?: string;
}): ReactNode {
  const label = useAddressLabel(address);
  const truncated = label ? short(address, 4, 4) : short(address);
  return (
    <span className={className ?? "mono"} title={address}>
      {label ? `${label} (${truncated})` : truncated}
    </span>
  );
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * A deploy's transaction log.
 *
 * Each line states its own outcome, including the ones with no hash: a refused
 * step was never broadcast, and showing a blank where a hash would go would read
 * as a missing receipt rather than as the pre-flight path doing its job.
 */
export function OutcomeList({
  steps,
}: {
  steps: Array<{ label: string; result: { kind: string; hash?: string; ledger?: number | null; detail?: string } }>;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      {steps.map((step) => (
        <div key={step.label} className="tiny" style={{ marginBottom: 5 }}>
          <span
            className="pill"
            style={{
              color: step.result.kind === "submitted" ? "var(--ok)" : "var(--danger)",
            }}
          >
            {step.result.kind}
          </span>{" "}
          <span className="mono">{step.label}</span>
          {step.result.hash && (
            <div className="mono" style={{ marginLeft: 4 }}>
              tx {starLink(step.result.hash)} ledger {step.result.ledger ?? "-"}
            </div>
          )}
          {step.result.detail && <div className="mono muted">{step.result.detail}</div>}
        </div>
      ))}
    </div>
  );
}

export function starLink(hash: string): ReactNode {
  return (
    <a href={`https://stellar.expert/explorer/testnet/tx/${hash}`} target="_blank" rel="noreferrer">
      <span className="mono">{short(hash, 10, 6)}</span>
    </a>
  );
}

export interface AmountDisplayProps extends FormatStroopsOptions {
  /** Amount in stroops (BigInt-safe). */
  stroops: bigint | number | string;
}

/**
 * Render a stroop amount human-readably, with a one-click toggle to the
 * exact raw stroops. A button (not a bare click target) so the toggle is
 * keyboard-operable and announced.
 */
export function AmountDisplay({ stroops, symbol, decimals }: AmountDisplayProps) {
  const [showRaw, setShowRaw] = useState(false);
  const human = formatStroopsWithUnit(stroops, { symbol, decimals });
  const raw = formatRawStroops(stroops);
  return (
    <button
      type="button"
      className="mono"
      onClick={() => setShowRaw((v) => !v)}
      aria-label={showRaw ? `Raw amount: ${raw}` : `Amount: ${human}. Activate to show raw stroops.`}
      title={showRaw ? "Show human-readable amount" : "Show raw stroops"}
    >
      {showRaw ? raw : human}
    </button>
  );
}
