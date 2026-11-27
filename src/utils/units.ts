import { ONE } from "@cowprotocol/cow-sdk";

export const BPS = 10_000n;
export const HEALTH_FACTOR_UNIT = 10n ** 18n;

// Ceiling division for a nonnegative amount and positive divisor.
export function ceilDiv(amount: bigint, divisor: bigint): bigint {
  return (amount + divisor - ONE) / divisor;
}

export function tokenUnit(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}
