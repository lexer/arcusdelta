import {describe, expect, it} from 'vitest';
import {maxLiquidityForAmounts, TickMath} from '@uniswap/v3-sdk';
import {
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForLiquidity,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getLiquidityForAmounts,
} from './liquidityMath.js';
import {getSqrtRatioAtTick} from './tickMath.js';

// The live USDG/NVDA 0.3% pool, tick 223440, with a +/-3% range aligned to
// spacing 60.
const CURRENT_TICK = 223440;
const LOWER_TICK = 223140;
const UPPER_TICK = 223740;

const CURRENT = getSqrtRatioAtTick(CURRENT_TICK);
const LOWER = getSqrtRatioAtTick(LOWER_TICK);
const UPPER = getSqrtRatioAtTick(UPPER_TICK);

const Q96 = 2n ** 96n;

/**
 * The official implementation, as the source of truth.
 *
 * Driven from ticks rather than bigints so the JSBI values come from the SDK
 * itself — tickMath.test.ts already proves the two sqrt-ratio functions agree
 * exactly, so both sides start from identical prices.
 */
function officialLiquidity(
  currentTick: number,
  lowerTick: number,
  upperTick: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  return BigInt(
    maxLiquidityForAmounts(
      TickMath.getSqrtRatioAtTick(currentTick),
      TickMath.getSqrtRatioAtTick(lowerTick),
      TickMath.getSqrtRatioAtTick(upperTick),
      amount0.toString(),
      amount1.toString(),
      true,
    ).toString(),
  );
}

/**
 * Flooring liquidity discards up to one unit, which in token terms is worth
 * the range width divided by Q96. That, plus one for the rounding-up on the
 * way back, bounds any honest round-trip loss.
 */
function roundTripBound(lower: bigint, upper: bigint): bigint {
  return (upper - lower) / Q96 + 1n;
}

describe('getLiquidityForAmounts', () => {
  it('matches the official implementation in range', () => {
    const amount0 = 5_000_000n; // 5 USDG
    const amount1 = 25_178_400_616_157_272n; // ~0.0252 NVDA

    expect(
      getLiquidityForAmounts(CURRENT, LOWER, UPPER, amount0, amount1),
    ).toBe(
      officialLiquidity(CURRENT_TICK, LOWER_TICK, UPPER_TICK, amount0, amount1),
    );
  });

  it('matches the official implementation below the range', () => {
    expect(
      getLiquidityForAmounts(
        getSqrtRatioAtTick(222000),
        LOWER,
        UPPER,
        5_000_000n,
        10n ** 17n,
      ),
    ).toBe(
      officialLiquidity(222000, LOWER_TICK, UPPER_TICK, 5_000_000n, 10n ** 17n),
    );
  });

  it('matches the official implementation above the range', () => {
    expect(
      getLiquidityForAmounts(
        getSqrtRatioAtTick(225000),
        LOWER,
        UPPER,
        5_000_000n,
        10n ** 17n,
      ),
    ).toBe(
      officialLiquidity(225000, LOWER_TICK, UPPER_TICK, 5_000_000n, 10n ** 17n),
    );
  });

  it('matches the official implementation across many ranges', () => {
    for (let width = 60; width <= 3000; width += 240) {
      const lowerTick = CURRENT_TICK - width;
      const upperTick = CURRENT_TICK + width;
      const amount0 = 12_345_678n;
      const amount1 = 987_654_321_000_000_000n;

      expect(
        getLiquidityForAmounts(
          CURRENT,
          getSqrtRatioAtTick(lowerTick),
          getSqrtRatioAtTick(upperTick),
          amount0,
          amount1,
        ),
      ).toBe(
        officialLiquidity(CURRENT_TICK, lowerTick, upperTick, amount0, amount1),
      );
    }
  });

  it('is bounded by the scarcer side', () => {
    const plentiful = getLiquidityForAmounts(
      CURRENT,
      LOWER,
      UPPER,
      10n ** 18n,
      1n,
    );
    expect(plentiful).toBe(getLiquidityForAmount1(LOWER, CURRENT, 1n));
  });
});

describe('amount round trips', () => {
  it('recovers at least the token1 that produced the liquidity', () => {
    const amount1 = 25_178_400_616_157_272n;
    const liquidity = getLiquidityForAmount1(LOWER, CURRENT, amount1);

    const recovered = getAmount1ForLiquidity(LOWER, CURRENT, liquidity);

    expect(recovered).toBeLessThanOrEqual(amount1);
    expect(amount1 - recovered).toBeLessThanOrEqual(
      roundTripBound(LOWER, CURRENT),
    );
  });

  it('recovers at least the token0 that produced the liquidity', () => {
    const amount0 = 5_000_000n;
    const liquidity = getLiquidityForAmount0(CURRENT, UPPER, amount0);

    const recovered = getAmount0ForLiquidity(CURRENT, UPPER, liquidity);

    expect(recovered).toBeLessThanOrEqual(amount0);
    expect(amount0 - recovered).toBeLessThanOrEqual(
      roundTripBound(CURRENT, UPPER),
    );
  });
});

describe('getAmountsForLiquidity', () => {
  it('needs both tokens when the price is inside the range', () => {
    const {amount0, amount1} = getAmountsForLiquidity(
      CURRENT,
      LOWER,
      UPPER,
      1_000_000_000n,
    );

    expect(amount0).toBeGreaterThan(0n);
    expect(amount1).toBeGreaterThan(0n);
  });

  it('needs only token0 when the price is below the range', () => {
    const {amount0, amount1} = getAmountsForLiquidity(
      getSqrtRatioAtTick(222000),
      LOWER,
      UPPER,
      1_000_000_000n,
    );

    expect(amount0).toBeGreaterThan(0n);
    expect(amount1).toBe(0n);
  });

  it('needs only token1 when the price is above the range', () => {
    const {amount0, amount1} = getAmountsForLiquidity(
      getSqrtRatioAtTick(225000),
      LOWER,
      UPPER,
      1_000_000_000n,
    );

    expect(amount0).toBe(0n);
    expect(amount1).toBeGreaterThan(0n);
  });

  it('returns nothing for a degenerate range', () => {
    expect(getAmount0ForLiquidity(CURRENT, CURRENT, 10n ** 12n)).toBe(0n);
    expect(getAmount1ForLiquidity(CURRENT, CURRENT, 10n ** 12n)).toBe(0n);
  });

  it('is insensitive to the order of the range bounds', () => {
    expect(getAmountsForLiquidity(CURRENT, UPPER, LOWER, 10n ** 9n)).toEqual(
      getAmountsForLiquidity(CURRENT, LOWER, UPPER, 10n ** 9n),
    );
  });
});
