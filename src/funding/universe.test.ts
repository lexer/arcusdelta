import type {TokenInfo} from '@arcus-xyz/arcus-spot-sdk';
import {describe, expect, it} from 'vitest';
import type {MarketSpec} from '../perps/types.js';
import {buildUniverse} from './universe.js';

function makeSpec(overrides: Partial<MarketSpec> = {}): MarketSpec {
  return {
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
    ...overrides,
  };
}

function makeToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    chainId: 4663,
    symbol: 'NVDA',
    name: 'NVIDIA',
    address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
    decimals: 18,
    ...overrides,
  } as TokenInfo;
}

describe('buildUniverse', () => {
  it('pairs a market with its spot token', () => {
    const {tradable} = buildUniverse([makeSpec()], [makeToken()]);

    expect(tradable).toEqual([
      {
        symbol: 'NVDA',
        market: 'NVDA-USD',
        marketId: 28,
        stockTokenAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
        stockTokenDecimals: 18,
        category: 'EQUITIES',
        tickSize: '0.01',
        stepSize: '0.0000001',
        minOrderNotional: '5',
      },
    ]);
  });

  it('excludes crypto markets even when a token of the same ticker exists', () => {
    const {tradable, perpOnly} = buildUniverse(
      [makeSpec({market: 'BTC-USD', baseAsset: 'BTC', category: 'CRYPTO'})],
      [makeToken({symbol: 'BTC'})],
    );

    expect(tradable).toEqual([]);
    expect(perpOnly).toEqual([]);
  });

  it('includes commodities and indices alongside equities', () => {
    const {tradable} = buildUniverse(
      [
        makeSpec({
          market: 'SLV-USD',
          baseAsset: 'SLV',
          category: 'COMMODITIES',
        }),
        makeSpec({market: 'SPY-USD', baseAsset: 'SPY', category: 'INDICES'}),
      ],
      [makeToken({symbol: 'SLV'}), makeToken({symbol: 'SPY'})],
    );

    expect(tradable.map(pair => pair.symbol)).toEqual(['SLV', 'SPY']);
  });

  it('reports an RWA market with no spot token as perp-only', () => {
    const {tradable, perpOnly} = buildUniverse(
      [makeSpec({market: 'HOOD-USD', baseAsset: 'HOOD'})],
      [makeToken()],
    );

    expect(tradable).toEqual([]);
    expect(perpOnly).toEqual(['HOOD-USD']);
  });

  it('skips a market that is not ONLINE, since the hedge leg would be missing', () => {
    const {tradable, perpOnly} = buildUniverse(
      [makeSpec({status: 'HALTED'})],
      [makeToken()],
    );

    expect(tradable).toEqual([]);
    expect(perpOnly).toEqual([]);
  });

  it('matches tickers case-insensitively', () => {
    const {tradable} = buildUniverse(
      [makeSpec({baseAsset: 'nvda'})],
      [makeToken({symbol: 'NVDA'})],
    );

    expect(tradable).toHaveLength(1);
  });
});
