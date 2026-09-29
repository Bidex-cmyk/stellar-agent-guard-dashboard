import { GuardProvider } from "../../components/GuardProvider.tsx";
import { WalletBar } from "../../components/WalletBar.tsx";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import { PanicPanel } from "../../components/PanicPanel.tsx";
import { ScopeNotice } from "../../components/bits.tsx";

/**
 * The emergency screen: on-chain state and the panic button on one page, at a
 * URL an operator can reach without navigating.
 *
 * Freezing is time-critical by definition, so this route pairs the two-step
 * freeze confirmation with the live `status()` read above it — the operator
 * sees the account's own `admin_frozen` flag flip and is not asked to trust the
 * button that changed it.
 */
export default function PanicPage() {
  return (
    <GuardProvider>
      <WalletBar />
      <StatusPanel />
      <PanicPanel />
      <ScopeNotice compact />
    </GuardProvider>
  );
}
