"use client";

/**
 * The telemetry query's date/time range picker (#148).
 *
 * Operators investigating a historical incident need "everything between
 * Tuesday 14:00 and 16:00", not only the live tail. This picker expresses
 * that range with presets (last hour / 24 hours / 7 days) or an explicit
 * custom calendar range, and reports Unix-seconds bounds to `TelemetryFeed`,
 * which converts them to ledger sequences via `ledgerTime.ts` — the chain
 * queries ledgers, humans think in timestamps.
 *
 * Accessibility follows the console's existing conventions: every control is
 * a labelled native control (so it works with a keyboard and a screen reader
 * with no extra widget code), and the preset group is a radiogroup because
 * the presets are mutually exclusive choices.
 */

import { useMemo, useState } from "react";
import {
  RANGE_PRESETS,
  datetimeLocalToUnixSecs,
  resolvePreset,
  validateRange,
  type RangePreset,
  type TimeRange,
} from "../lib/guard/ledgerTime.ts";

/**
 * Apply a preset range to `onApply`, resolving it against the current clock.
 *
 * Defined at module level because it reads the clock — an impure call — and
 * the React compiler's purity rule correctly forbids that inside a component
 * body, while an event-handler helper outside it is exactly where a clock
 * read belongs.
 */
function applyPreset(
  preset: Exclude<RangePreset, "custom">,
  onApply: (range: TimeRange, preset: RangePreset) => void,
): void {
  const nowSecs = Math.floor(Date.now() / 1000);
  onApply(resolvePreset(preset, nowSecs), preset);
}

export function DateRangePicker({
  onApply,
  disabled = false,
}: {
  onApply: (range: TimeRange, preset: RangePreset) => void;
  disabled?: boolean;
}) {
  const [preset, setPreset] = useState<RangePreset>("24h");
  const [fromValue, setFromValue] = useState("");
  const [toValue, setToValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const customRange = useMemo<TimeRange>(
    () => ({
      fromUnixSecs: datetimeLocalToUnixSecs(fromValue),
      toUnixSecs: datetimeLocalToUnixSecs(toValue),
    }),
    [fromValue, toValue],
  );

  function choosePreset(next: RangePreset) {
    setPreset(next);
    setError(null);
    if (next !== "custom") {
      // Presets apply immediately: they need no further input, and a telemetry
      // range that requires a second click to take effect reads as broken.
      applyPreset(next, onApply);
    }
  }

  function applyCustom() {
    if (validateRange(customRange) !== null) {
      setError(validateRange(customRange));
      return;
    }
    setError(null);
    onApply(customRange, "custom");
  }

  return (
    <div className="stack" role="group" aria-label="Telemetry time range">
      <div className="row" role="radiogroup" aria-label="Time range preset">
        {RANGE_PRESETS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={preset === id}
            className="secondary"
            style={preset === id ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
            onClick={() => choosePreset(id)}
            disabled={disabled}
          >
            {label}
          </button>
        ))}
      </div>

      {preset === "custom" && (
        <>
          <div className="row">
            <label className="field" style={{ marginBottom: 0, flex: 1 }}>
              <span className="lbl">From</span>
              <input
                type="datetime-local"
                value={fromValue}
                onChange={(event) => {
                  setFromValue(event.target.value);
                  setError(null);
                }}
                disabled={disabled}
                aria-label="Range start date and time"
              />
            </label>
            <label className="field" style={{ marginBottom: 0, flex: 1 }}>
              <span className="lbl">To</span>
              <input
                type="datetime-local"
                value={toValue}
                onChange={(event) => {
                  setToValue(event.target.value);
                  setError(null);
                }}
                disabled={disabled}
                aria-label="Range end date and time"
              />
            </label>
            <button onClick={applyCustom} disabled={disabled} style={{ alignSelf: "flex-end" }}>
              Apply range
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              <span className="t">That range cannot be queried</span>
              <span className="tiny">{error}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
