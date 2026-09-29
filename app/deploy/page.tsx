import { GuardProvider } from "../../components/GuardProvider.tsx";
import { WalletBar } from "../../components/WalletBar.tsx";
import { DeployPanel } from "../../components/DeployPanel.tsx";
import { ScopeNotice } from "../../components/bits.tsx";

/**
 * The deployment step of the operator lifecycle, as its own addressable screen.
 *
 * The console (`/`) keeps deploy next to everything else, but an operator
 * provisioning a fresh guard — or an automation walking the deploy → configure →
 * freeze lifecycle end to end — wants a URL that lands straight on the deploy
 * flow with the wallet and guard selector in front of it.
 */
export default function DeployPage() {
  return (
    <GuardProvider>
      <WalletBar />
      <DeployPanel />
      <ScopeNotice compact />
    </GuardProvider>
  );
}
