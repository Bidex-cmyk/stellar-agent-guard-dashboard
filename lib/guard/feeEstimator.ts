export type FeePreset = 'Economic' | 'Standard' | 'Fast';

export function calculateFeeHeadroom(
  cpu: number,
  baseFee: bigint,
  preset: FeePreset = 'Standard',
  maxFeeCap?: bigint
) {
  let multiplier: bigint;
  let cpuMultiplier: number;

  switch (preset) {
    case 'Economic':
      multiplier = 105n;
      cpuMultiplier = 1.05;
      break;
    case 'Fast':
      multiplier = 130n;
      cpuMultiplier = 1.30;
      break;
    case 'Standard':
    default:
      multiplier = 115n;
      cpuMultiplier = 1.15;
      break;
  }

  const paddedCpu = Math.ceil(cpu * cpuMultiplier);
  let paddedFee = (baseFee * multiplier) / 100n;

  if (maxFeeCap !== undefined && paddedFee > maxFeeCap) {
    paddedFee = maxFeeCap;
  }

  return { cpu: paddedCpu, fee: paddedFee };
}
