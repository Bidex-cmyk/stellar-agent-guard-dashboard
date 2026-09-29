import { SubmitSignedXDRPanel } from "../components/SubmitSignedXDRPanel.tsx";
import { GuardProvider } from "../components/GuardProvider.tsx";
import { WalletBar } from "../components/WalletBar.tsx";
import { StatusPanel } from "../components/StatusPanel.tsx";
import { TxHistoryTable } from "../components/TxHistoryTable.tsx";
import { TelemetryFeed } from "../components/TelemetryFeed.tsx";
import { MultisigTracker } from "../components/MultisigTracker.tsx";
import { PanicPanel } from "../components/PanicPanel.tsx";
import { HardwareWalletGuide } from "../components/HardwareWalletGuide.tsx";
import { DashboardGrid, type GridPanel } from "../components/DashboardGrid.tsx";
import { ScopeNotice } from "../components/bits.tsx";

/**
 * The console's panels, in the default order. The operator can reorder,
 * collapse and reset these from the grid; `DashboardGrid` owns the
 * arrangement and its persistence.
 */
const PANELS: GridPanel[] = [
  { id: "status", title: "On-chain state", content: <StatusPanel /> },
  { id: "txhistory", title: "Transaction history", content: <TxHistoryTable /> },
  { id: "panic", title: "Emergency", content: <PanicPanel /> },
  { id: "telemetry", title: "Telemetry", content: <TelemetryFeed /> },
  { id: "multisig", title: "Multisig approvals", content: <MultisigTracker /> },
  { id: "xdr", title: "Submit Signed XDR", content: <SubmitSignedXDRPanel /> },
];

export default function ConsolePage() {
  return (
    <GuardProvider>
      <HardwareWalletGuide />
      <WalletBar />
      <DashboardGrid panels={PANELS} />
      <ScopeNotice compact />
    </GuardProvider>
  );
}
