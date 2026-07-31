/**
 * Turns a deviation percentage into a concrete, spacing-aligned tick range.
 *
 * Price is exponential in tick (p = 1.0001^tick), so a symmetric ±X% band in
 * price is *asymmetric* in ticks: -3% is ~305 ticks down while +3% is ~296
 * ticks up. Computing each side independently keeps the realized band centered
 * on the price rather than on the tick.
 */

import {alignTickOutward, MAX_TICK, MIN_TICK} from './tickMath.js';

const LOG_TICK_BASE = Math.log(1.0001);

export interface TickRange {
  readonly tickLower: number;
  readonly tickUpper: number;
}

/**
 * Range covering `deviationPercent` either side of `currentTick`.
 *
 * Bounds are aligned outward to `tickSpacing`, so the realized range is never
 * narrower than requested.
 */
export function calculateRange(
  currentTick: number,
  deviationPercent: number,
  tickSpacing: number,
): TickRange {
  if (!(deviationPercent > 0)) {
    throw new RangeError(
      `deviation percent must be greater than zero, got ${deviationPercent}`,
    );
  }
  if (deviationPercent >= 100) {
    throw new RangeError(
      `deviation percent must be below 100, got ${deviationPercent}`,
    );
  }
  if (tickSpacing <= 0) {
    throw new RangeError(`tick spacing must be positive, got ${tickSpacing}`);
  }

  const fraction = deviationPercent / 100;
  const ticksDown = Math.log(1 - fraction) / LOG_TICK_BASE;
  const ticksUp = Math.log(1 + fraction) / LOG_TICK_BASE;

  const rawLower = Math.max(currentTick + ticksDown, MIN_TICK);
  const rawUpper = Math.min(currentTick + ticksUp, MAX_TICK);

  const tickLower = alignTickOutward(rawLower, tickSpacing, 'down');
  const tickUpper = alignTickOutward(rawUpper, tickSpacing, 'up');

  if (tickLower >= tickUpper) {
    throw new RangeError(
      `Computed an empty range [${tickLower}, ${tickUpper}] from tick ` +
        `${currentTick} at ${deviationPercent}% with spacing ${tickSpacing}`,
    );
  }

  return {tickLower, tickUpper};
}
