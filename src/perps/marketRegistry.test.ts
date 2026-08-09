import {describe, expect, it, vi} from 'vitest';
import {
  PerpMarketNotFoundError,
  PerpsAlignmentError,
  PerpsOrderSizeError,
} from './errors.js';
import {
  compareDecimals,
  divideDecimals,
  floorToIncrement,
  MarketRegistry,
  multiplyDecimals,
  toEngineOrder,
  toIncrements,
  toMarketSpec,
} from './marketRegistry.js';
import type {PerpMarket} from './types.js';

/** Shaped from the live `GET /v1/markets` row for NVDA-USD. */
function makeMarket(overrides: Partial<PerpMarket> = {}): PerpMarket {
  return {
    marketDisplayName: 'NVDA-USD',
    fullAssetName: 'NVIDIA',
    marketId: 28,
    status: 'ONLINE',
    baseAsset: 'NVDA',
    quoteAsset: 'USD',
    tickSize: '0.01',
    stepSize: '0.0000001',
    minOrderNotional: '5',
    minOrderSize: '0.01',
    maxOrderSize: '100000',
    oraclePrice: '224.31',
    markPrice: '224.34',
    lastTradePrice: '224.3',
    fundingRate: '0.00000480324074074',
    nextFundingAt: 1786269600,
    openInterest: '125.85',
    initialMarginFraction: '0.1',
    maintenanceMarginFraction: '0.066667',
    offHoursInitialMarginFraction: '0.15',
    isOutsideRth: true,
    type: 'PERPETUAL',
    category: 'EQUITIES',
    ...overrides,
  };
}

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
});

describe('toMarketSpec', () => {
  it('keeps the static fields and drops the live ones', () => {
    const spec = toMarketSpec(makeMarket());

    expect(spec).toEqual({
      market: 'NVDA-USD',
      marketId: 28,
      baseAsset: 'NVDA',
      status: 'ONLINE',
      category: 'EQUITIES',
      tickSize: '0.01',
      stepSize: '0.0000001',
      minOrderSize: '0.01',
      maxOrderSize: '100000',
      minOrderNotional: '5',
      initialMarginFraction: '0.1',
      maintenanceMarginFraction: '0.066667',
      offHoursInitialMarginFraction: '0.15',
    });
    expect(spec).not.toHaveProperty('markPrice');
    expect(spec).not.toHaveProperty('fundingRate');
    expect(spec).not.toHaveProperty('isOutsideRth');
  });
});

describe('toEngineOrder', () => {
  const spec = toMarketSpec(makeMarket());

  it('returns the human decimals and the engine integers together', () => {
    expect(toEngineOrder(spec, '224.39', '0.5')).toEqual({
      price: '224.39',
      quantity: '0.5',
      priceTicks: 22439n,
      quantityQuantums: 5000000n,
    });
  });

  it('rejects a price off the tick grid', () => {
    expect(() => toEngineOrder(spec, '224.395', '0.5')).toThrow(
      PerpsAlignmentError,
    );
  });

  it('rejects a size off the step grid', () => {
    expect(() => toEngineOrder(spec, '224.39', '0.50000005')).toThrow(
      PerpsAlignmentError,
    );
  });

  it('rejects a size above maxOrderSize', () => {
    expect(() => toEngineOrder(spec, '224.39', '100001')).toThrow(
      PerpsOrderSizeError,
    );
  });

  it('rejects a size below minOrderSize', () => {
    expect(() => toEngineOrder(spec, '224.39', '0.001')).toThrow(
      PerpsOrderSizeError,
    );
  });

  it('rejects a notional under the market minimum', () => {
    // 0.01 * 224.39 = 2.24, under the $5 floor.
    expect(() => toEngineOrder(spec, '224.39', '0.01')).toThrow(
      /minOrderNotional/,
    );
  });

  it('exempts a reduce-only order from the minimum notional', () => {
    expect(
      toEngineOrder(spec, '224.39', '0.01', {reduceOnly: true}),
    ).toMatchObject({quantity: '0.01'});
  });

  it('rejects a zero or negative price', () => {
    expect(() => toEngineOrder(spec, '0', '0.5')).toThrow(PerpsOrderSizeError);
  });
});

describe('MarketRegistry', () => {
  it('resolves a market by name, case-insensitively', async () => {
    const source = {getMarkets: vi.fn().mockResolvedValue([makeMarket()])};
    const registry = new MarketRegistry(source);

    expect((await registry.byMarket('nvda-usd')).marketId).toBe(28);
  });

  it('resolves a market by base asset', async () => {
    const source = {getMarkets: vi.fn().mockResolvedValue([makeMarket()])};
    const registry = new MarketRegistry(source);

    expect((await registry.byBaseAsset('nvda')).market).toBe('NVDA-USD');
  });

  it('fetches the market list only once across lookups', async () => {
    const source = {getMarkets: vi.fn().mockResolvedValue([makeMarket()])};
    const registry = new MarketRegistry(source);

    await registry.byMarket('NVDA-USD');
    await registry.byBaseAsset('NVDA');
    await registry.all();

    expect(source.getMarkets).toHaveBeenCalledTimes(1);
  });

  it('throws for an unknown market name', async () => {
    const source = {getMarkets: vi.fn().mockResolvedValue([makeMarket()])};
    const registry = new MarketRegistry(source);

    await expect(registry.byMarket('WAT-USD')).rejects.toThrow(
      PerpMarketNotFoundError,
    );
  });

  it('throws for an unknown base asset', async () => {
    const source = {getMarkets: vi.fn().mockResolvedValue([makeMarket()])};
    const registry = new MarketRegistry(source);

    await expect(registry.byBaseAsset('WAT')).rejects.toThrow(
      PerpMarketNotFoundError,
    );
  });

  it('re-fetches on every live() call so prices are never stale', async () => {
    const source = {
      getMarkets: vi
        .fn()
        .mockResolvedValueOnce([makeMarket({markPrice: '224.34'})])
        .mockResolvedValueOnce([makeMarket({markPrice: '225.10'})]),
    };
    const registry = new MarketRegistry(source);

    expect((await registry.live('NVDA-USD')).markPrice).toBe('224.34');
    expect((await registry.live('NVDA-USD')).markPrice).toBe('225.10');
    expect(source.getMarkets).toHaveBeenCalledTimes(2);
  });
});
