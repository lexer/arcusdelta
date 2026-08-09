/**
 * Exact arithmetic on the decimal strings the exchange speaks.
 *
 * Every price, size, and balance on the Arcus API is a decimal *string*, and
 * the matching engine takes prices in **ticks** (`price / tickSize`) and sizes
 * in **quantums** (`size / stepSize`) — exact integers that also go into the
 * signed order payload. A rounding error here is not a rejected order, it is a
 * validly signed order for the wrong amount. So everything runs in `bigint` on
 * scaled values, and anything that cannot be represented exactly throws rather
 * than rounding.
 *
 * Float is fine for statistics and display (see `fundingAnalyzer.ts`); it is
 * never fine for an amount that reaches an order.
 */

import {formatUnits, parseUnits} from 'viem';
import {PerpsAlignmentError} from './errors.js';

/**
 * Fixed-point scale for every conversion below. Comfortably above the
 * exchange's finest increment (BTC's `stepSize` is 1e-8) and matches the
 * 18-decimal convention the rest of the codebase already uses for atoms.
 */
const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

/** Decimal string -> scaled bigint. Throws on anything `parseUnits` rejects. */
function scale(value: string): bigint {
  return parseUnits(value, SCALE);
}

/** Scaled bigint -> decimal string, trailing zeros trimmed. */
function unscale(value: bigint): string {
  return formatUnits(value, SCALE);
}

/**
 * Exact integer count of `increment` in `value`.
 *
 * Throws {@link PerpsAlignmentError} when `value` is not a whole multiple —
 * the engine would reject it with `Tick`, and silently rounding here would
 * change the size or price the operator asked for.
 */
export function toIncrements(value: string, increment: string): bigint {
  const scaledIncrement = scale(increment);
  if (scaledIncrement <= 0n) {
    throw new PerpsAlignmentError(
      `Increment must be positive, got ${increment}`,
      value,
      increment,
    );
  }

  const scaledValue = scale(value);
  if (scaledValue % scaledIncrement !== 0n) {
    throw new PerpsAlignmentError(
      `${value} is not a whole multiple of ${increment}`,
      value,
      increment,
    );
  }
  return scaledValue / scaledIncrement;
}

/** Largest multiple of `increment` at or below `value`. */
export function floorToIncrement(value: string, increment: string): string {
  const scaledIncrement = scale(increment);
  if (scaledIncrement <= 0n) {
    throw new PerpsAlignmentError(
      `Increment must be positive, got ${increment}`,
      value,
      increment,
    );
  }

  const scaledValue = scale(value);
  // bigint division truncates toward zero, which is the wrong direction for a
  // negative value — a residual delta can legitimately be negative.
  let steps = scaledValue / scaledIncrement;
  if (scaledValue % scaledIncrement !== 0n && scaledValue < 0n) steps -= 1n;
  return unscale(steps * scaledIncrement);
}

/** Product of two decimal strings, exact, as a decimal string. */
export function multiplyDecimals(a: string, b: string): string {
  return unscale((scale(a) * scale(b)) / ONE);
}

/** `a / b` as a decimal string, truncated to {@link SCALE} places. */
export function divideDecimals(a: string, b: string): string {
  const divisor = scale(b);
  if (divisor === 0n) throw new RangeError('Division by zero');
  return unscale((scale(a) * ONE) / divisor);
}

export function addDecimals(a: string, b: string): string {
  return unscale(scale(a) + scale(b));
}

export function subtractDecimals(a: string, b: string): string {
  return unscale(scale(a) - scale(b));
}

/** Signed comparison of two decimal strings. */
export function compareDecimals(a: string, b: string): number {
  const left = scale(a);
  const right = scale(b);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function isPositive(value: string): boolean {
  return scale(value) > 0n;
}

/** Magnitude, dropping the sign. */
export function absDecimals(value: string): string {
  const scaled = scale(value);
  return unscale(scaled < 0n ? -scaled : scaled);
}

/**
 * Size-weighted mean of `(weight, value)` pairs, e.g. an average fill price
 * across several partial fills. Zero total weight yields `undefined` rather
 * than a division by zero — no fills means no average.
 */
export function weightedAverage(
  entries: ReadonlyArray<readonly [weight: string, value: string]>,
): string | undefined {
  let totalWeight = 0n;
  let weightedSum = 0n;
  for (const [weight, value] of entries) {
    const scaledWeight = scale(weight);
    totalWeight += scaledWeight;
    weightedSum += (scaledWeight * scale(value)) / ONE;
  }
  if (totalWeight === 0n) return undefined;
  return unscale((weightedSum * ONE) / totalWeight);
}
