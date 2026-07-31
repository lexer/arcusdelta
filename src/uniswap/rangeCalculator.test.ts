import {describe, expect, it} from 'vitest';
import {calculateRange} from './rangeCalculator.js';
import {getSqrtRatioAtTick, MAX_TICK, MIN_TICK} from './tickMath.js';

/** Price ratio between two ticks, via the exact sqrt-price math. */
function priceRatio(fromTick: number, toTick: number): number {
  const from = Number(getSqrtRatioAtTick(fromTick));
  const to = Number(getSqrtRatioAtTick(toTick));
  return (to / from) ** 2;
}

describe('calculateRange', () => {
  it('brackets the live pool tick at 3%', () => {
    const {tickLower, tickUpper} = calculateRange(223440, 3, 60);

    expect(tickLower).toBeLessThan(223440);
    expect(tickUpper).toBeGreaterThan(223440);
    expect(tickLower % 60).toBe(0);
    expect(tickUpper % 60).toBe(0);
  });

  it('covers at least the requested deviation on both sides', () => {
    const {tickLower, tickUpper} = calculateRange(223440, 3, 60);

    // Aligning outward means the realized band is >= the requested one.
    expect(priceRatio(223440, tickLower)).toBeLessThanOrEqual(0.97);
    expect(priceRatio(223440, tickUpper)).toBeGreaterThanOrEqual(1.03);
  });

  it('is asymmetric in ticks because price is exponential', () => {
    const current = 223440;
    const {tickLower, tickUpper} = calculateRange(current, 3, 1);

    // -3% is further in ticks than +3%.
    expect(current - tickLower).toBeGreaterThan(tickUpper - current);
  });

  it('widens as the deviation grows', () => {
    const narrow = calculateRange(223440, 1, 60);
    const wide = calculateRange(223440, 10, 60);

    expect(wide.tickLower).toBeLessThan(narrow.tickLower);
    expect(wide.tickUpper).toBeGreaterThan(narrow.tickUpper);
  });

  it('respects tick spacing for every supported pool', () => {
    for (const spacing of [1, 10, 60, 200]) {
      const {tickLower, tickUpper} = calculateRange(223440, 3, spacing);

      expect(tickLower % spacing).toBe(0);
      expect(tickUpper % spacing).toBe(0);
      expect(tickLower).toBeLessThan(tickUpper);
    }
  });

  it('handles negative ticks', () => {
    const {tickLower, tickUpper} = calculateRange(-50000, 3, 60);

    expect(tickLower).toBeLessThan(-50000);
    expect(tickUpper).toBeGreaterThan(-50000);
    expect(Math.abs(tickLower % 60)).toBe(0);
    expect(Math.abs(tickUpper % 60)).toBe(0);
  });

  it('stays within the valid tick range near the extremes', () => {
    const low = calculateRange(MIN_TICK + 100, 50, 60);
    const high = calculateRange(MAX_TICK - 100, 50, 60);

    expect(low.tickLower).toBeGreaterThanOrEqual(MIN_TICK);
    expect(high.tickUpper).toBeLessThanOrEqual(MAX_TICK);
  });

  it('rejects a non-positive deviation', () => {
    expect(() => calculateRange(223440, 0, 60)).toThrow(RangeError);
    expect(() => calculateRange(223440, -3, 60)).toThrow(RangeError);
  });

  it('rejects a deviation of 100% or more', () => {
    expect(() => calculateRange(223440, 100, 60)).toThrow(RangeError);
  });

  it('rejects a non-positive tick spacing', () => {
    expect(() => calculateRange(223440, 3, 0)).toThrow(RangeError);
  });
});
