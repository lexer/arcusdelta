import {describe, expect, it} from 'vitest';
import {getSqrtRatioAtTick} from '../uniswap/tickMath.js';
import {
  accruedFees,
  computePnl,
  poolPriceUsdgPerStock,
  valueInUsdg,
  type PnlInputs,
} from './pnlCalculator.js';

const USDG_DECIMALS = 6;
const STOCK_DECIMALS = 18;

describe('poolPriceUsdgPerStock', () => {
  it('recovers the live pool price', () => {
    // Observed on chain: tick 223440 in the USDG/NVDA pool, ~198 USDG per NVDA.
    const price = poolPriceUsdgPerStock(
      getSqrtRatioAtTick(223440),
      USDG_DECIMALS,
      STOCK_DECIMALS,
    );

    expect(price).toBeGreaterThan(190);
    expect(price).toBeLessThan(210);
  });

  it('falls as the tick rises, since USDG is currency0', () => {
    const lower = poolPriceUsdgPerStock(
      getSqrtRatioAtTick(223000),
      USDG_DECIMALS,
      STOCK_DECIMALS,
    );
    const higher = poolPriceUsdgPerStock(
      getSqrtRatioAtTick(224000),
      USDG_DECIMALS,
      STOCK_DECIMALS,
    );

    expect(higher).toBeLessThan(lower);
  });

  it('returns zero rather than infinity for a degenerate price', () => {
    expect(poolPriceUsdgPerStock(0n, USDG_DECIMALS, STOCK_DECIMALS)).toBe(0);
  });
});

describe('accruedFees', () => {
  it('reproduces the fees read from the live position', () => {
    // tokenId 422596, read from StateView.
    const {fees0, fees1} = accruedFees(
      60_210_398_382_745n,
      7_685_209_671_248_051_714_120_297_456_278n,
      39_355_508_630_248_240_174_357_965_892_606_147_015_148n,
      7_623_132_171_635_300_410_892_319_181_130n,
      38_951_241_200_658_619_592_182_522_523_042_443_779_097n,
    );

    expect(fees0).toBe(10_984n);
    expect(fees1).toBe(71_532_072_640_175n);
  });

  it('reports nothing when growth has not moved', () => {
    expect(accruedFees(1_000n, 5n, 7n, 5n, 7n)).toEqual({
      fees0: 0n,
      fees1: 0n,
    });
  });

  it('scales with liquidity', () => {
    const single = accruedFees(1_000_000n, 2n ** 128n, 0n, 0n, 0n);
    const double = accruedFees(2_000_000n, 2n ** 128n, 0n, 0n, 0n);

    expect(double.fees0).toBe(single.fees0 * 2n);
  });

  it('handles accumulator overflow, which the pool allows', () => {
    // Growth wrapped past 2^256; the delta must still come out small.
    const {fees0} = accruedFees(1_000n, 5n, 0n, 2n ** 256n - 5n, 0n);

    expect(fees0).toBe((1_000n * 10n) / 2n ** 128n);
    expect(fees0).toBeGreaterThanOrEqual(0n);
  });

  it('never returns a negative amount', () => {
    const {fees0, fees1} = accruedFees(
      10n ** 12n,
      1n,
      1n,
      2n ** 255n,
      2n ** 255n,
    );

    expect(fees0).toBeGreaterThanOrEqual(0n);
    expect(fees1).toBeGreaterThanOrEqual(0n);
  });
});

describe('valueInUsdg', () => {
  it('converts stock atoms at the given price', () => {
    expect(valueInUsdg(10n ** 18n, 18, 200)).toBeCloseTo(200, 6);
    expect(valueInUsdg(5n * 10n ** 17n, 18, 200)).toBeCloseTo(100, 6);
  });

  it('is zero for no balance', () => {
    expect(valueInUsdg(0n, 18, 200)).toBe(0);
  });
});

function inputs(overrides: Partial<PnlInputs> = {}): PnlInputs {
  return {
    usdgSpent: 15_000_000n, // 15 USDG
    usdgReceived: 0n,
    usdgDepositedToLp: 0n,
    stockBalance: 0n,
    lpUsdg: 7_000_000n, // 7 USDG
    lpStock: 40_000_000_000_000_000n, // 0.04 stock
    fees0: 10_984n,
    fees1: 71_532_072_640_175n,
    usdgDecimals: USDG_DECIMALS,
    stockDecimals: STOCK_DECIMALS,
    priceUsdgPerStock: 198.6,
    ...overrides,
  };
}

describe('computePnl', () => {
  it('counts an unsold position as still deployed, not as a loss', () => {
    const result = computePnl(inputs());

    expect(result.capitalInUsdg).toBeCloseTo(15, 6);
    expect(result.openValueUsdg).toBeGreaterThan(0);
    expect(result.netUsdg).toBeGreaterThan(-result.capitalInUsdg);
  });

  it('counts USDG deposited into the position as capital, not profit', () => {
    // The USDG side of a deposit comes from the wallet and never touches
    // Arcus. Omitting it invents profit equal to that amount.
    const ignored = computePnl(inputs({lpUsdg: 11_853_166n}));
    const counted = computePnl(
      inputs({lpUsdg: 11_853_166n, usdgDepositedToLp: 13_000_000n}),
    );

    expect(counted.capitalInUsdg).toBeCloseTo(28, 6);
    expect(counted.netUsdg).toBeCloseTo(ignored.netUsdg - 13, 6);
    expect(counted.netUsdg).toBeLessThan(ignored.netUsdg);
  });

  it('nets to zero when a deposit is worth exactly what funded it', () => {
    const result = computePnl({
      usdgSpent: 0n,
      usdgReceived: 0n,
      usdgDepositedToLp: 10_000_000n,
      stockBalance: 0n,
      lpUsdg: 10_000_000n,
      lpStock: 0n,
      fees0: 0n,
      fees1: 0n,
      usdgDecimals: USDG_DECIMALS,
      stockDecimals: STOCK_DECIMALS,
      priceUsdgPerStock: 198.6,
    });

    expect(result.netUsdg).toBeCloseTo(0, 9);
  });

  it('values fees on both sides of the pool', () => {
    const withFees = computePnl(inputs());
    const withoutFees = computePnl(inputs({fees0: 0n, fees1: 0n}));

    expect(withFees.feesUsdg).toBeGreaterThan(0);
    expect(withFees.netUsdg).toBeGreaterThan(withoutFees.netUsdg);
    // 0.010984 USDG plus ~0.0142 USDG of stock.
    expect(withFees.feesUsdg).toBeCloseTo(0.0252, 3);
  });

  it('reduces to received minus spent once everything is closed', () => {
    const result = computePnl(
      inputs({
        usdgReceived: 16_000_000n,
        lpUsdg: 0n,
        lpStock: 0n,
        fees0: 0n,
        fees1: 0n,
      }),
    );

    expect(result.capitalOutUsdg).toBeCloseTo(16, 6);
    expect(result.openValueUsdg).toBe(0);
    expect(result.netUsdg).toBeCloseTo(1, 6);
  });

  it('breaks even when the round trip returns exactly what it cost', () => {
    const result = computePnl(
      inputs({
        usdgReceived: 15_000_000n,
        lpUsdg: 0n,
        lpStock: 0n,
        fees0: 0n,
        fees1: 0n,
      }),
    );

    expect(result.netUsdg).toBeCloseTo(0, 9);
    expect(result.returnFraction).toBeCloseTo(0, 9);
  });

  it('reports a loss as negative', () => {
    const result = computePnl(
      inputs({
        usdgReceived: 14_000_000n,
        lpUsdg: 0n,
        lpStock: 0n,
        fees0: 0n,
        fees1: 0n,
      }),
    );

    expect(result.netUsdg).toBeCloseTo(-1, 6);
    expect(result.returnFraction).toBeLessThan(0);
  });

  it('counts loose stock in the wallet as deployed value', () => {
    const held = computePnl(
      inputs({stockBalance: 10n ** 17n, lpUsdg: 0n, lpStock: 0n}),
    );

    // 0.1 stock at 198.6.
    expect(held.openValueUsdg).toBeCloseTo(19.86, 2);
  });

  it('does not divide by zero when nothing was ever deployed', () => {
    const result = computePnl(
      inputs({
        usdgSpent: 0n,
        usdgReceived: 0n,
        lpUsdg: 0n,
        lpStock: 0n,
        fees0: 0n,
        fees1: 0n,
        stockBalance: 0n,
      }),
    );

    expect(result.returnFraction).toBe(0);
    expect(Number.isFinite(result.netUsdg)).toBe(true);
  });
});
