import {describe, expect, it} from 'vitest';
import {
  absDecimals,
  addDecimals,
  compareDecimals,
  divideDecimals,
  floorToIncrement,
  isPositive,
  multiplyDecimals,
  subtractDecimals,
  toIncrements,
  weightedAverage,
} from './decimal.js';
import {PerpsAlignmentError} from './errors.js';

describe('toIncrements', () => {
  it('converts an aligned price to integer ticks', () => {
    expect(toIncrements('224.39', '0.01')).toBe(22439n);
  });

  it('converts an aligned size to integer quantums', () => {
    expect(toIncrements('0.4449308', '0.0000001')).toBe(4449308n);
  });

  it('handles a whole-number increment', () => {
    expect(toIncrements('50', '5')).toBe(10n);
  });

  it('returns zero for a zero value', () => {
    expect(toIncrements('0', '0.01')).toBe(0n);
  });

  it('rejects a value off the grid rather than rounding it', () => {
    expect(() => toIncrements('224.395', '0.01')).toThrow(PerpsAlignmentError);
  });

  it('rejects a non-positive increment', () => {
    expect(() => toIncrements('1', '0')).toThrow(PerpsAlignmentError);
  });

  it('stays exact at a size where float division would not', () => {
    // 0.29 / 0.01 is 28.999999999999996 in IEEE 754 doubles.
    expect(toIncrements('0.29', '0.01')).toBe(29n);
  });
});

describe('floorToIncrement', () => {
  it('rounds a size down to the step grid', () => {
    expect(floorToIncrement('0.44493085', '0.0000001')).toBe('0.4449308');
  });

  it('leaves an already-aligned value untouched', () => {
    expect(floorToIncrement('224.39', '0.01')).toBe('224.39');
  });

  it('floors toward negative infinity, not toward zero', () => {
    // A residual delta can be negative; truncating toward zero would report
    // a smaller imbalance than actually exists.
    expect(floorToIncrement('-0.15', '0.1')).toBe('-0.2');
  });

  it('can floor all the way to zero', () => {
    expect(floorToIncrement('0.004', '0.01')).toBe('0');
  });
});

describe('decimal arithmetic', () => {
  it('multiplies without float drift', () => {
    expect(multiplyDecimals('224.39', '3')).toBe('673.17');
  });

  it('divides a notional into a base quantity', () => {
    expect(divideDecimals('1000', '250')).toBe('4');
  });

  it('rejects division by zero', () => {
    expect(() => divideDecimals('1', '0')).toThrow(RangeError);
  });

  it('compares decimal strings by value, not lexically', () => {
    expect(compareDecimals('9', '10')).toBe(-1);
    expect(compareDecimals('10', '9')).toBe(1);
    expect(compareDecimals('10.0', '10')).toBe(0);
  });

  it('adds and subtracts exactly where floats would drift', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE 754.
    expect(addDecimals('0.1', '0.2')).toBe('0.3');
    expect(subtractDecimals('0.3', '0.1')).toBe('0.2');
  });

  it('subtracts past zero into a negative', () => {
    expect(subtractDecimals('0.1', '0.25')).toBe('-0.15');
  });

  it('reports positivity', () => {
    expect(isPositive('0.0000001')).toBe(true);
    expect(isPositive('0')).toBe(false);
    expect(isPositive('-1')).toBe(false);
  });

  it('takes a magnitude', () => {
    expect(absDecimals('-0.15')).toBe('0.15');
    expect(absDecimals('0.15')).toBe('0.15');
  });
});

describe('weightedAverage', () => {
  it('averages fills by size', () => {
    // 1 @ 100 and 3 @ 200 -> 175.
    expect(
      weightedAverage([
        ['1', '100'],
        ['3', '200'],
      ]),
    ).toBe('175');
  });

  it('returns a single fill price unchanged', () => {
    expect(weightedAverage([['0.03', '224.38']])).toBe('224.38');
  });

  it('is undefined with no fills, rather than dividing by zero', () => {
    expect(weightedAverage([])).toBeUndefined();
    expect(weightedAverage([['0', '224.38']])).toBeUndefined();
  });
});
