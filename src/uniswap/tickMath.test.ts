import {describe, expect, it} from 'vitest';
import {TickMath} from '@uniswap/v3-sdk';
import {
  alignTickOutward,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
} from './tickMath.js';

/** The official implementation, as the source of truth. */
function officialSqrtRatio(tick: number): bigint {
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
}

describe('getSqrtRatioAtTick', () => {
  it('matches the live pool observation', () => {
    // Read from StateView on Robinhood Chain: USDG/NVDA 0.3% pool.
    expect(getSqrtRatioAtTick(223440)).toBe(officialSqrtRatio(223440));
  });

  it('matches the official implementation at the bounds', () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(officialSqrtRatio(MIN_TICK));
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(officialSqrtRatio(MAX_TICK));
  });

  it('matches the official implementation across the tick range', () => {
    for (let tick = -887000; tick <= 887000; tick += 4409) {
      expect(getSqrtRatioAtTick(tick)).toBe(officialSqrtRatio(tick));
    }
  });

  it('matches the official implementation near zero', () => {
    for (let tick = -600; tick <= 600; tick++) {
      expect(getSqrtRatioAtTick(tick)).toBe(officialSqrtRatio(tick));
    }
  });

  it('matches the official implementation around the pool tick', () => {
    for (let tick = 223000; tick <= 224000; tick += 7) {
      expect(getSqrtRatioAtTick(tick)).toBe(officialSqrtRatio(tick));
    }
  });

  it('is monotonically increasing', () => {
    let previous = getSqrtRatioAtTick(-1000);
    for (let tick = -999; tick <= 1000; tick++) {
      const current = getSqrtRatioAtTick(tick);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('rejects ticks outside the valid range', () => {
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(1.5)).toThrow(RangeError);
  });
});

describe('getTickAtSqrtRatio', () => {
  it('round-trips every tick it is given', () => {
    for (let tick = -880000; tick <= 880000; tick += 3571) {
      expect(getTickAtSqrtRatio(getSqrtRatioAtTick(tick))).toBe(tick);
    }
  });

  it('round-trips the live pool tick', () => {
    expect(getTickAtSqrtRatio(getSqrtRatioAtTick(223440))).toBe(223440);
  });

  it('recovers the tick from the observed on-chain sqrt price', () => {
    // slot0.sqrtPriceX96 read from the USDG/NVDA 0.3% pool at tick 223440.
    const observed = 5630988710377423664134631725262565n;
    expect(getTickAtSqrtRatio(observed)).toBe(223440);
  });

  it('returns the greatest tick at or below the ratio', () => {
    const ratio = getSqrtRatioAtTick(1000);
    expect(getTickAtSqrtRatio(ratio + 1n)).toBe(1000);
    expect(getTickAtSqrtRatio(ratio - 1n)).toBe(999);
  });

  it('rejects ratios outside the valid range', () => {
    expect(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow(RangeError);
    expect(() => getTickAtSqrtRatio(MAX_SQRT_RATIO)).toThrow(RangeError);
  });
});

describe('alignTickOutward', () => {
  it('widens rather than narrows', () => {
    expect(alignTickOutward(223145, 60, 'down')).toBe(223140);
    expect(alignTickOutward(223735, 60, 'up')).toBe(223740);
  });

  it('leaves exact multiples alone', () => {
    expect(alignTickOutward(223440, 60, 'down')).toBe(223440);
    expect(alignTickOutward(223440, 60, 'up')).toBe(223440);
  });

  it('handles negative ticks in the widening direction', () => {
    expect(alignTickOutward(-145, 60, 'down')).toBe(-180);
    expect(alignTickOutward(-145, 60, 'up')).toBe(-120);
  });

  it('stays inside the valid tick range at the extremes', () => {
    const low = alignTickOutward(MIN_TICK, 60, 'down');
    const high = alignTickOutward(MAX_TICK, 60, 'up');

    expect(low).toBeGreaterThanOrEqual(MIN_TICK);
    expect(high).toBeLessThanOrEqual(MAX_TICK);
    // Math.abs normalizes -0, which a negative multiple produces.
    expect(Math.abs(low % 60)).toBe(0);
    expect(Math.abs(high % 60)).toBe(0);
  });

  it('rejects a non-positive spacing', () => {
    expect(() => alignTickOutward(100, 0, 'up')).toThrow(RangeError);
  });
});
