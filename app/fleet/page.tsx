import { GuardProvider } from "../../components/GuardProvider.tsx";
import { WalletBar } from "../../components/WalletBar.tsx";
import { FleetTable } from "../../components/FleetTable.tsx";
import { HardwareWalletGuide } from "../../components/HardwareWalletGuide.tsx";

export default function FleetPage() {
  return (
    <GuardProvider>
      <HardwareWalletGuide />
      <WalletBar />
      <FleetTable />
    </GuardProvider>
  );
}
