"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SpecFunction } from "../lib/guard/contractSpecParser.ts";
import { firstDocSentence, formatSpecSignature } from "../lib/guard/contractSpecParser.ts";

/**
 * A searchable, keyboard-navigable multi-select of a contract's exported
 * functions, backed by the spec parsed from its WASM.
 *
 * The list is rendered as a listbox of checkbox-styled options rather than a
 * `<select multiple>`: a Soroban contract can export dozens of functions, so
 * the picker has to filter as the operator types, and multi-selects are hard
 * to aim with a mouse. Keyboard support (arrows to move the active option,
 * Enter/Space to toggle, Home/End/Escape) follows the WAI-ARIA combobox
 * listbox pattern so the picker is operable without a pointer.
 *
 * All identity and ordering decisions come from the caller: `options` is the
 * spec order, `selected` is the policy's order, and this component only ever
 * reports toggles. Keeping the policy model out of the picker is what lets it
 * stay a dumb, fully testable view.
 */
export function FunctionPicker({
  options,
  selected,
  onToggle,
  onClear,
  contractLabel,
}: {
  /** Every exported function, in spec order. */
  options: SpecFunction[];
  /** The currently allowlisted symbols, in policy order. */
  selected: string[];
  /** Called once per user toggle with the option's exact name. */
  onToggle: (name: string) => void;
  /** Deselect everything; only rendered when there is something to clear. */
  onClear: () => void;
  /** A human name for the source contract, used for announcements. */
  contractLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputId = useId();

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.name.toLowerCase().includes(needle));
  }, [options, query]);

  // Clamp during render rather than in an effect: when the query narrows the
  // list, the active index has to shrink with it before painting.
  const clampedIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));

  // Close on outside pointer-down (a click inside must not close the picker).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggle(name: string) {
    onToggle(name);
  }

  function openAndReset() {
    setOpen(true);
    setActiveIndex(0);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      if (open) {
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        openAndReset();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex(Math.min(clampedIndex + 1, matches.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex(Math.max(clampedIndex - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(matches.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (matches[clampedIndex]) toggle(matches[clampedIndex].name);
        break;
      default:
        break;
    }
  }

  const listboxId = `${inputId}-listbox`;
  const showClear = selected.length > 0;
  const showList = open && matches.length > 0;

  return (
    <div className="fn-picker" ref={rootRef}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listboxId : undefined}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-label={`Filter exported functions of ${contractLabel}`}
          value={query}
          placeholder="Filter functions…"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {showClear && (
          <button className="secondary" type="button" onClick={onClear}>
            Clear selection
          </button>
        )}
      </div>

      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={`Exported functions of ${contractLabel}`}
          className="fn-list"
          ref={listRef}
        >
          {matches.map((option, index) => {
            const isSelected = selectedSet.has(option.name);
            const doc = firstDocSentence(option);
            const isActive = index === clampedIndex;
            return (
              <li
                key={option.name}
                role="option"
                aria-selected={isSelected}
                aria-label={formatSpecSignature(option)}
                className={`fn-option${isActive ? " active" : ""}${isSelected ? " selected" : ""}`}
                onMouseDown={(event) => {
                  // `mousedown` so the choice lands before a focus blur can
                  // close the list; preventDefault keeps focus on the filter.
                  event.preventDefault();
                }}
                onClick={() => toggle(option.name)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  readOnly
                  tabIndex={-1}
                  aria-hidden="true"
                />
                <span className="fn-name mono">{option.name}</span>
                <span className="fn-sig tiny muted">{formatSpecSignature(option)}</span>
                {doc && <span className="fn-doc tiny muted">{doc}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {open && matches.length === 0 && (
        <div className="tiny muted" style={{ marginTop: 4 }}>
          No exported function matches “{query.trim()}”.
        </div>
      )}

      {selected.length > 0 && (
        <div className="row fn-chips" style={{ marginTop: 8 }}>
          {selected.map((name) => (
            <button
              key={name}
              type="button"
              className="pill fn-chip"
              title={`Stop allowing ${name}`}
              aria-label={`Remove ${name} from the allowlist`}
              onClick={() => toggle(name)}
            >
              {name} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
