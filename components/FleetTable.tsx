"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatStroopsWithUnit } from "../lib/guard/formatters.ts";
import {
  pollFleet,
  filterFleet,
  sortFleet,
  type FleetRow,
  type DerivedStatus,
  type SortKey,
} from "../lib/guard/fleet.ts";
import { loadInstances } from "../lib/guard/instance.ts";
import { freezeGuard } from "../lib/guard/guardOps.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { useGuard } from "./GuardProvider.tsx";
import { starLink } from "./bits.tsx";
import { useRouter } from "next/navigation";
import { freighterSigner } from "../lib/guard/wallet.ts";

export function FleetTable() {
  const { wallet, server } = useGuard();
  const router = useRouter();
  
  const [rows, setRows] = useState<FleetRow[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [search, setSearch] = useState("");
  const [networkFilter, setNetworkFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DerivedStatus | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetchFleet = async () => {
      const instances = loadInstances();
      const contacts = instances.map((i) => ({
        address: i.guard,
        label: i.label,
        addedAt: "",
      }));
      const result = await pollFleet(server, contacts);
      if (mounted) {
        setRows(result);
        setLoading(false);
      }
    };
    
    fetchFleet();
    const interval = setInterval(fetchFleet, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [server]);

  const filteredAndSorted = useMemo(() => {
    return sortFleet(filterFleet(rows, search, networkFilter, statusFilter), sortKey);
  }, [rows, search, networkFilter, statusFilter, sortKey]);

  const handleFreeze = async (guard: string) => {
    if (!wallet) {
      alert("Please connect your wallet first to freeze a guard.");
      return;
    }
    try {
      await freezeGuard({
        server,
        signer: freighterSigner(wallet.address, NETWORK.passphrase),
        guard,
      });
    } catch (err) {
      console.error(err);
    }
  };

  const renderStatus = (status: DerivedStatus) => {
    switch (status) {
      case "Active":
        return <span className="pill ok">Active</span>;
      case "Frozen":
        return <span className="pill danger">Frozen</span>;
      case "Expired":
        return <span className="pill warn">Expired</span>;
      default:
        return <span className="pill muted">Unknown</span>;
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Fleet Overview</h2>
        <span className="tiny muted">
          {rows.length} guard{rows.length !== 1 ? "s" : ""} in registry
        </span>
      </div>

      <div className="split" style={{ marginTop: 12 }}>
        <label className="field" style={{ marginBottom: 0, flex: 2 }}>
          <span className="lbl">Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or address..."
          />
        </label>
        
        <div className="row" style={{ flex: 3 }}>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Network</span>
            <select
              value={networkFilter || ""}
              onChange={(e) => setNetworkFilter(e.target.value || null)}
            >
              <option value="">All Networks</option>
              <option value={NETWORK.name}>{NETWORK.name}</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Status</span>
            <select
              value={statusFilter || ""}
              onChange={(e) =>
                setStatusFilter((e.target.value as DerivedStatus) || null)
              }
            >
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Frozen">Frozen</option>
              <option value="Expired">Expired</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Sort</span>
            <select
              value={sortKey || ""}
              onChange={(e) => setSortKey((e.target.value as SortKey) || null)}
            >
              <option value="">None</option>
              <option value="spend">Spend (High to Low)</option>
              <option value="expiration">Expiration (Soonest)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="scrolly" style={{ marginTop: 14 }}>
        <table className="events">
          <thead>
            <tr>
              <th>Guard</th>
              <th>Network</th>
              <th>Status</th>
              <th>24h Spend</th>
              <th>DMS Countdown</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="tiny muted"
                  style={{ textAlign: "center", padding: "20px" }}
                >
                  Loading fleet data...
                </td>
              </tr>
            ) : filteredAndSorted.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="tiny muted"
                  style={{ textAlign: "center", padding: "20px" }}
                >
                  No guards found
                </td>
              </tr>
            ) : (
              filteredAndSorted.map((row) => (
                <tr key={row.contact.address}>
                  <td>
                    <div>
                      <strong>{row.contact.label}</strong>
                    </div>
                    <div className="mono tiny">
                      {starLink(row.contact.address)}
                    </div>
                  </td>
                  <td className="tiny">{row.network}</td>
                  <td>{renderStatus(row.derivedStatus)}</td>
                  <td className="mono tiny">
                    {formatStroopsWithUnit(row.spend24h)}
                  </td>
                  <td className="mono tiny">
                    {row.dmsCountdownSecs !== null
                      ? `${row.dmsCountdownSecs}s`
                      : "—"}
                  </td>
                  <td>
                    <div className="row" style={{ gap: "8px" }}>
                      <button
                        className="secondary"
                        style={{ padding: "4px 8px", fontSize: "0.8em" }}
                        onClick={() => router.push(`/?guard=${row.contact.address}`)}
                      >
                        Inspect
                      </button>
                      <button
                        className="secondary"
                        style={{ padding: "4px 8px", fontSize: "0.8em" }}
                        onClick={() => handleFreeze(row.contact.address)}
                        disabled={row.derivedStatus === "Frozen"}
                      >
                        Freeze
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
