"use client";

import type { TelemetryFilter } from "../lib/guard/telemetry";

interface TelemetryFilterBarProps {
  filter: TelemetryFilter;
  onChange: (filter: TelemetryFilter) => void;
  totalEvents: number;
  filteredCount: number;
}

export function TelemetryFilterBar({
  filter,
  onChange,
  totalEvents,
  filteredCount,
}: TelemetryFilterBarProps) {
  function handleOutcomeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    onChange({ ...filter, outcome: e.target.value as TelemetryFilter["outcome"] });
  }

  function handleEventTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    onChange({ ...filter, eventType: e.target.value as TelemetryFilter["eventType"] });
  }

  function handleAddressChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange({ ...filter, addressSearch: e.target.value });
  }

  function handleMinStroopsChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.trim();
    if (val === "") {
      onChange({ ...filter, minStroops: null });
    } else {
      try {
        onChange({ ...filter, minStroops: BigInt(val) });
      } catch {
        // invalid number, ignore
      }
    }
  }

  function handleClear() {
    onChange({ ...TelemetryFilterBar.defaultFilter } as TelemetryFilter);
  }

  return (
    <div className="filter-bar" role="toolbar" aria-label="Event filters">
      <div className="filter-row">
        <label>
          Outcome:{" "}
          <select value={filter.outcome} onChange={handleOutcomeChange}>
            <option value="all">All</option>
            <option value="approved-only">Approved Only</option>
            <option value="blocked-only">Blocked Only</option>
          </select>
        </label>

        <label>
          Event Type:{" "}
          <select value={filter.eventType} onChange={handleEventTypeChange}>
            <option value="all">All</option>
            <option value="auth_checked">auth_checked</option>
            <option value="heartbeat">heartbeat</option>
            <option value="policy_set">policy_set</option>
            <option value="frozen">frozen</option>
          </select>
        </label>

        <label>
          Address / Hash:{" "}
          <input
            type="text"
            value={filter.addressSearch}
            onChange={handleAddressChange}
            placeholder="C… or TX hash"
          />
        </label>

        <label>
          Min Stroops:{" "}
          <input
            type="text"
            value={filter.minStroops !== null ? filter.minStroops.toString() : ""}
            onChange={handleMinStroopsChange}
            placeholder="e.g. 10000000"
          />
        </label>

        <button className="secondary" onClick={handleClear}>
          Clear filters
        </button>
      </div>

      <p className="tiny muted">
        Showing {filteredCount} of {totalEvents} events
      </p>
    </div>
  );
}

const defaultFilter: TelemetryFilter = {
  outcome: "all",
  eventType: "all",
  addressSearch: "",
  minStroops: null,
};

TelemetryFilterBar.defaultFilter = defaultFilter;
