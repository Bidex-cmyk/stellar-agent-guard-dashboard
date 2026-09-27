export interface VelocityMetrics {
  spend1m: bigint;
  spend15m: bigint;
  spend1h: bigint;
  exhaustionMinutes: number | null;
}

/**
 * Computes moving averages of spend rates and predicts cap exhaustion.
 */
export function calculateVelocity(
  entries: Array<{ ts: bigint; amount: bigint }>,
  now: bigint,
  remainingCap: bigint | null
): VelocityMetrics {
  let spend1m = 0n;
  let spend15m = 0n;
  let spend1h = 0n;

  for (const entry of entries) {
    const age = now - entry.ts;
    // Handle future timestamps gracefully
    if (age < 0n) continue;

    if (age <= 60n) {
      spend1m += entry.amount;
    }
    if (age <= 15n * 60n) {
      spend15m += entry.amount;
    }
    if (age <= 60n * 60n) {
      spend1h += entry.amount;
    }
  }

  let exhaustionMinutes: number | null = null;
  if (remainingCap !== null) {
    // Determine the current spend rate per minute.
    // We use the 15-minute moving average as the baseline, falling back to 1m if needed.
    let ratePerMinute = 0;
    
    if (spend15m > 0n) {
      ratePerMinute = Number(spend15m) / 15.0;
    } else if (spend1m > 0n) {
      ratePerMinute = Number(spend1m);
    } else if (spend1h > 0n) {
      ratePerMinute = Number(spend1h) / 60.0;
    }

    if (ratePerMinute > 0) {
      exhaustionMinutes = Number(remainingCap) / ratePerMinute;
    }
  }

  return {
    spend1m,
    spend15m,
    spend1h,
    exhaustionMinutes,
  };
}
