import { rpc } from "@stellar/stellar-sdk";
import type { Contact } from "./addressBook.ts";
import * as guardOps from "./guardOps.ts";
import type { GuardSnapshot } from "./guardOps.ts";
import { NETWORK } from "./network.ts";

export type DerivedStatus = "Active" | "Frozen" | "Expired" | "Unknown";

export interface FleetRow {
  contact: Contact;
  snapshot: GuardSnapshot | null;
  error?: string;
  derivedStatus: DerivedStatus;
  spend24h: bigint;
  dmsCountdownSecs: bigint | null;
  network: string;
}

export async function pollFleet(
  server: rpc.Server,
  contacts: Contact[],
  _readSnapshot = guardOps.readGuardSnapshot
): Promise<FleetRow[]> {
  const promises = contacts.map(async (contact) => {
    try {
      const snapshot = await _readSnapshot(server, contact.address);
      let derivedStatus: DerivedStatus = "Unknown";
      let dmsCountdownSecs: bigint | null = null;
      let spend24h = 0n;

      if (snapshot.status.ok) {
        if (snapshot.status.value.admin_frozen) {
          derivedStatus = "Frozen";
        } else if (snapshot.status.value.heartbeat_expired) {
          derivedStatus = "Expired";
        } else {
          derivedStatus = "Active";
        }

        if (snapshot.policy.ok && snapshot.policy.value) {
          const grace = snapshot.policy.value.dms_grace_secs;
          const lastHb = snapshot.status.value.last_heartbeat;
          const now = snapshot.status.value.now;
          if (grace > 0n && lastHb > 0n) {
            const remaining = (lastHb + grace) - now;
            dmsCountdownSecs = remaining > 0n ? remaining : 0n;
          }
        }
      }

      if (snapshot.window.ok && snapshot.window.value) {
        spend24h = snapshot.window.value.total;
      }

      return {
        contact,
        snapshot,
        derivedStatus,
        spend24h,
        dmsCountdownSecs,
        network: NETWORK.name,
      };
    } catch (error) {
      return {
        contact,
        snapshot: null,
        error: error instanceof Error ? error.message : String(error),
        derivedStatus: "Unknown" as DerivedStatus,
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: NETWORK.name,
      };
    }
  });

  return Promise.all(promises);
}

export function filterFleet(
  rows: FleetRow[],
  search: string,
  networkFilter: string | null,
  statusFilter: DerivedStatus | null
): FleetRow[] {
  const q = search.toLowerCase();
  return rows.filter((row) => {
    if (networkFilter && row.network !== networkFilter) return false;
    if (statusFilter && row.derivedStatus !== statusFilter) return false;
    if (q) {
      const labelMatch = row.contact.label.toLowerCase().includes(q);
      const addressMatch = row.contact.address.toLowerCase().includes(q);
      if (!labelMatch && !addressMatch) return false;
    }
    return true;
  });
}

export type SortKey = "spend" | "expiration";

export function sortFleet(rows: FleetRow[], sortKey: SortKey | null): FleetRow[] {
  if (!sortKey) return rows;
  return [...rows].sort((a, b) => {
    if (sortKey === "spend") {
      return a.spend24h < b.spend24h ? 1 : a.spend24h > b.spend24h ? -1 : 0;
    }
    if (sortKey === "expiration") {
      // Missing countdowns go to the end
      const aDms = a.dmsCountdownSecs ?? 9999999999999n;
      const bDms = b.dmsCountdownSecs ?? 9999999999999n;
      return aDms < bDms ? -1 : aDms > bDms ? 1 : 0;
    }
    return 0;
  });
}
