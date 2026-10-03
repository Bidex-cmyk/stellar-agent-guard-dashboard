export interface TokenMetadata {
  decimals: number;
  symbol: string;
  name: string;
  warning?: string;
}

const cache = new Map<string, TokenMetadata>();

// Validates if an address looks like a SAC contract (C-address)
function isSACAddress(contractId: string): boolean {
  return contractId.startsWith("C") && contractId.length === 56;
}

export async function fetchTokenMetadata(rpc: string, contractId: string): Promise<TokenMetadata> {
  if (cache.has(contractId)) return cache.get(contractId)!;

  if (!isSACAddress(contractId)) {
    const meta: TokenMetadata = {
      decimals: 7,
      symbol: "UNKNOWN",
      name: "Unknown Token",
      warning: `Contract "${contractId}" does not appear to be a valid SAC address. Metadata may be unavailable.`,
    };
    cache.set(contractId, meta);
    return meta;
  }

  try {
    // Simulate Soroban RPC calls for decimals(), symbol(), name()
    const simulate = async (method: string): Promise<string> => {
      const response = await fetch(`${rpc}/simulate_transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractId, method, args: [] }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      const result = (data as { result?: string }).result ?? "";
      return result;
    };

    const [decimalsStr, symbol, name] = await Promise.all([
      simulate("decimals"),
      simulate("symbol"),
      simulate("name"),
    ]);

    const meta: TokenMetadata = {
      decimals: parseInt(decimalsStr, 10) || 7,
      symbol: symbol || "XLM",
      name: name || "Stellar Lumens",
    };
    cache.set(contractId, meta);
    return meta;
  } catch {
    const meta: TokenMetadata = {
      decimals: 7,
      symbol: "XLM",
      name: "Stellar",
      warning: `Failed to query token metadata for "${contractId}" via Soroban RPC. Using defaults.`,
    };
    cache.set(contractId, meta);
    return meta;
  }
}
