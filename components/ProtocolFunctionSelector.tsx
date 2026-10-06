"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PolicyDraft } from "../lib/guard/policyForm.ts";
import {
  exportedFunctionNames,
  parseContractSpec,
  type ContractSpecResult,
  type SpecFunction,
} from "../lib/guard/contractSpecParser.ts";
import { readContractSpec } from "../lib/guard/chain.ts";
import { DEMO_PROTOCOL_SPEC } from "../lib/guard/demoFixtures.ts";
import { FunctionPicker } from "./FunctionPicker.tsx";
import { useGuard } from "./GuardProvider.tsx";
import { isDemoMode } from "../lib/guard/demoFixtures.ts";

/**
 * Per-protocol function selection for one allowlisted contract.
 *
 * The policy model is a string — `C…:swap,deposit` on one line of
 * `draft.protocols` — so this component is the bridge between the operator's
 * pick and that wire format. When the contract publishes a spec, the picker
 * lists only names the contract will actually accept; when it does not
 * (stripped or corrupt spec, or the bytes cannot be read at all), the panel
 * falls back to manual entry and says so rather than leaving the operator to
 * guess why the list is empty.
 *
 * Everything here is a read: no simulation, no signing, and the fallback keeps
 * the form usable even when the RPC refuses the bytecode read.
 */
export function ProtocolFunctionSelector({
  draft,
  set,
}: {
  draft: PolicyDraft;
  set: <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) => void;
}) {
  const { server } = useGuard();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [functions, setFunctions] = useState<SpecFunction[] | null>(null);
  const [specResult, setSpecResult] = useState<ContractSpecResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** The allowlist lines, split into per-contract maps in draft order. */
  const rules = useMemo(() => {
    const out: Array<{ contract: string; fns: string[] | null }> = [];
    for (const line of draft.protocols.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(":");
      const contract = colon < 0 ? trimmed : trimmed.slice(0, colon);
      const tail = colon < 0 ? "" : trimmed.slice(colon + 1);
      const fns =
        tail.trim() === ""
          ? null
          : tail
              .split(",")
              .map((fn) => fn.trim())
              .filter(Boolean);
      out.push({ contract, fns });
    }
    return out;
  }, [draft.protocols]);

  const activeRule = expanded ? rules.find((rule) => rule.contract === expanded) : undefined;

  // The load effect keys off the raw protocol lines, not derived objects:
  // `rules` is rebuilt every render, so depending on it would re-fetch forever.
  const protocolLineFor = useCallback(
    (contract: string) =>
      draft.protocols
        .split("\n")
        .find((line) => line.trim().startsWith(contract))
        ?.trim() ?? "",
    [draft.protocols],
  );
  const activeLine = expanded ? protocolLineFor(expanded) : "";
  const activeContract = activeLine ? activeLine.split(":")[0]! : "";

  // Fetching and applying are separate, as in DeployPanel: the fetcher touches
  // no state, so the effect below has nothing synchronous to write and the old
  // picker stays on screen while a re-read is in flight. All state moves happen
  // together, once the chain (or the demo fixture) has answered.
  const fetchSpec = useCallback(
    async (
      contract: string,
    ): Promise<{ result: ContractSpecResult | null; error: string | null }> => {
      // Demo mode fabricates a DEX-like spec so the picker is explorable with
      // no chain behind it; outside demo mode this is a real RPC read.
      if (isDemoMode()) {
        return { result: parseContractSpec(DEMO_PROTOCOL_SPEC), error: null };
      }
      const read = await readContractSpec(server, contract);
      // A read failure is not a spec property: the bytes may be fine and the
      // RPC down. Either way the manual-entry fallback stays available.
      if (read.ok) return { result: read, error: null };
      const detail = read.reason === "fetch" ? read.error : read.message;
      return { result: null, error: detail };
    },
    [server],
  );

  // Load the spec whenever a contract is expanded (or the expanded target
  // changes), and again if the contract id is edited while open.
  useEffect(() => {
    if (!expanded || !activeContract) return;
    let cancelled = false;
    void (async () => {
      const { result, error } = await fetchSpec(activeContract);
      if (cancelled) return;
      setFunctions(result?.ok ? result.functions : []);
      setSpecResult(result);
      setLoadError(error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, activeContract, fetchSpec]);

  function replaceRule(contract: string, fns: string[] | null) {
    const line = fns && fns.length > 0 ? `${contract}:${fns.join(",")}` : contract;
    const next = rules.map((rule) => (rule.contract === contract ? line : rule.contract));
    set("protocols", next.join("\n"));
  }

  const names = useMemo(
    () => (functions ? exportedFunctionNames({ ok: true, functions }) : []),
    [functions],
  );

  if (rules.length === 0) {
    return (
      <p className="tiny muted" style={{ marginTop: 4 }}>
        Add a protocol contract above to pick the functions this policy allows.
      </p>
    );
  }

  return (
    <div className="field" style={{ marginTop: 8 }}>
      <span className="lbl">Allowed functions per protocol</span>
      <span className="hint">
        Pick functions from the contract&apos;s own interface spec instead of typing symbols. A
        contract with no selection allows any function.
      </span>
      <ul className="proto-list" style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
        {rules.map((rule) => {
          const isOpen = expanded === rule.contract;
          const summary =
            rule.fns === null
              ? "any function"
              : rule.fns.length === 0
                ? "no functions"
                : `${rule.fns.length} function(s)`;
          return (
            <li key={rule.contract} style={{ marginBottom: 6 }}>
              <button
                type="button"
                className="secondary"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : rule.contract)}
              >
                {isOpen ? "▾" : "▸"} <span className="mono">{rule.contract.slice(0, 12)}…</span> —{" "}
                {summary}
              </button>
              {isOpen && (
                <div style={{ marginTop: 6 }}>
                  {loading && <p className="tiny muted">Reading the contract spec from chain…</p>}
                  {loadError && (
                    <p className="tiny" style={{ color: "var(--warn)" }}>
                      Could not read the contract bytes: {loadError} — enter symbols manually below.
                    </p>
                  )}
                  {!loading && specResult && !specResult.ok && (
                    <p className="tiny" style={{ color: "var(--warn)" }} role="status">
                      {specResult.message}
                    </p>
                  )}
                  {functions && specResult?.ok && (
                    <FunctionPicker
                      options={functions}
                      selected={rule.fns ?? []}
                      onToggle={(name) => {
                        const current = new Set(rule.fns ?? []);
                        if (current.has(name)) current.delete(name);
                        else current.add(name);
                        replaceRule(rule.contract, [...current]);
                      }}
                      onClear={() => replaceRule(rule.contract, null)}
                      contractLabel={rule.contract}
                    />
                  )}
                  {(!specResult?.ok || loadError) && (
                    <input
                      type="text"
                      aria-label={`Manual function symbols for ${rule.contract}`}
                      value={rule.fns?.join(",") ?? ""}
                      placeholder="swap, deposit"
                      onChange={(event) => {
                        const fns = event.target.value
                          .split(",")
                          .map((fn) => fn.trim())
                          .filter(Boolean);
                        replaceRule(rule.contract, fns.length > 0 ? fns : null);
                      }}
                    />
                  )}
                  {names.length > 0 && (
                    <p className="tiny muted" style={{ marginTop: 4 }}>
                      {names.length} exported function{names.length === 1 ? "" : "s"} found in the
                      contract spec.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
