import {describe, expect, it} from 'vitest';
import {addDecimals, multiplyDecimals} from '../perps/decimal.js';
import {
  evaluateClose,
  formatOpportunity,
  type PairEntry,
  type PairExitQuote,
} from './closeOpportunity.js';

/** 1 unit long spot at 100, short perp at 101 — opened at a 1.00 premium. */
function makeEntry(overrides: Partial<PairEntry> = {}): PairEntry {
  return {
    symbol: 'NVDA',
    quantity: '1',
    perpEntryPrice: '101',
    spotCostUsdg: '100',
    ...overrides,
  };
}

function makeQuote(overrides: Partial<PairExitQuote> = {}): PairExitQuote {
  return {
    spotExitProceeds: '100',
    perpExitPrice: '101',
    fundingEarned: '0',
    ...overrides,
  };
}

describe('evaluateClose', () => {
  it('is flat when nothing moved', () => {
    const result = evaluateClose(makeEntry(), makeQuote(), 0);

    expect(result.spotPnl).toBe('0');
    expect(result.perpPnl).toBe('0');
    expect(result.netPnl).toBe('0');
    expect(result.basisConvergence).toBe('0');
  });

  it('profits when the basis narrows, however the underlying moved', () => {
    // Underlying up 10, but the 1.00 premium collapsed to 0.20.
    const result = evaluateClose(
      makeEntry(),
      makeQuote({spotExitProceeds: '110', perpExitPrice: '110.2'}),
      0,
    );

    expect(result.entryBasis).toBe('1');
    expect(result.currentBasis).toBe('0.2');
    expect(result.basisConvergence).toBe('0.8');
    expect(result.netPnl).toBe('0.8');
    expect(result.worthClosing).toBe(true);
  });

  it('loses when the basis widens, however the underlying moved', () => {
    // Underlying down 10, but the premium widened from 1.00 to 1.50.
    const result = evaluateClose(
      makeEntry(),
      makeQuote({spotExitProceeds: '90', perpExitPrice: '91.5'}),
      0,
    );

    expect(result.basisConvergence).toBe('-0.5');
    expect(result.netPnl).toBe('-0.5');
    expect(result.worthClosing).toBe(false);
  });

  it('is indifferent to a large parallel move in both legs', () => {
    const up = evaluateClose(
      makeEntry(),
      makeQuote({spotExitProceeds: '150', perpExitPrice: '151'}),
      0,
    );
    const down = evaluateClose(
      makeEntry(),
      makeQuote({spotExitProceeds: '50', perpExitPrice: '51'}),
      0,
    );

    expect(up.netPnl).toBe('0');
    expect(down.netPnl).toBe('0');
  });

  it('holds the identity: spotPnl + perpPnl equals quantity x basis convergence', () => {
    const entry = makeEntry({quantity: '3', spotCostUsdg: '300'});
    const result = evaluateClose(
      entry,
      makeQuote({spotExitProceeds: '318', perpExitPrice: '106.1'}),
      0,
    );

    expect(addDecimals(result.spotPnl, result.perpPnl)).toBe(
      multiplyDecimals(entry.quantity, result.basisConvergence),
    );
  });

  it('adds funding on top of the price result', () => {
    const result = evaluateClose(
      makeEntry(),
      makeQuote({fundingEarned: '0.25'}),
      0,
    );

    expect(result.netPnl).toBe('0.25');
  });

  it('lets funding carry an otherwise losing pair into profit', () => {
    const result = evaluateClose(
      makeEntry(),
      makeQuote({perpExitPrice: '101.1', fundingEarned: '0.3'}),
      0,
    );

    expect(result.perpPnl).toBe('-0.1');
    expect(result.netPnl).toBe('0.2');
    expect(result.worthClosing).toBe(true);
  });

  it('measures the result in basis points of the capital deployed', () => {
    const result = evaluateClose(
      makeEntry(),
      makeQuote({spotExitProceeds: '101'}),
      0,
    );

    // 1 on 100 is 100 bps.
    expect(result.netPnlBps).toBe('100');
  });

  it('holds below the threshold and closes at or above it', () => {
    const quote = makeQuote({spotExitProceeds: '100.4'});

    expect(evaluateClose(makeEntry(), quote, 50).worthClosing).toBe(false);
    expect(evaluateClose(makeEntry(), quote, 40).worthClosing).toBe(true);
    expect(evaluateClose(makeEntry(), quote, 20).worthClosing).toBe(true);
  });

  it('accepts a negative threshold, which is how a stop is expressed', () => {
    const losing = makeQuote({spotExitProceeds: '99.7'});

    expect(evaluateClose(makeEntry(), losing, 0).worthClosing).toBe(false);
    // -30 bps: exit rather than keep bleeding.
    expect(evaluateClose(makeEntry(), losing, -30).worthClosing).toBe(true);
  });

  it('charges exit costs through the quoted proceeds', () => {
    // Spot fetches 99.9 rather than 100 because of spread and impact.
    const result = evaluateClose(
      makeEntry(),
      makeQuote({spotExitProceeds: '99.9'}),
      0,
    );

    expect(result.netPnl).toBe('-0.1');
    expect(result.worthClosing).toBe(false);
  });

  it('scales with quantity', () => {
    const result = evaluateClose(
      makeEntry({quantity: '10', spotCostUsdg: '1000'}),
      makeQuote({spotExitProceeds: '1000', perpExitPrice: '100.5'}),
      0,
    );

    // 0.5 per unit x 10 units.
    expect(result.perpPnl).toBe('5');
    expect(result.netPnlBps).toBe('50');
  });

  it('handles the real rehearsal shape without drift', () => {
    const result = evaluateClose(
      {
        symbol: 'NVDA',
        quantity: '0.053',
        perpEntryPrice: '225.18',
        spotCostUsdg: '11.93454',
      },
      {
        spotExitProceeds: '11.93',
        perpExitPrice: '225.18',
        fundingEarned: '0.000057278',
      },
      0,
    );

    expect(result.perpPnl).toBe('0');
    expect(result.netPnl).toBe('-0.004482722');
  });
});

describe('formatOpportunity', () => {
  it('flags a pair worth closing', () => {
    const line = formatOpportunity(
      evaluateClose(makeEntry(), makeQuote({spotExitProceeds: '101'}), 50),
    );

    expect(line).toContain('NVDA');
    expect(line).toContain('CLOSE');
  });

  it('leaves an unprofitable pair unflagged', () => {
    const line = formatOpportunity(evaluateClose(makeEntry(), makeQuote(), 50));

    expect(line).not.toContain('CLOSE');
  });

  it('keeps a negative sign visible', () => {
    const line = formatOpportunity(
      evaluateClose(makeEntry(), makeQuote({spotExitProceeds: '99'}), 0),
    );

    expect(line).toContain('-1.0');
  });
});
