import {describe, expect, it} from 'vitest';
import type {
  FundingAnalysis,
  FundingStats,
} from '../funding/fundingAnalyzer.js';
import {
  buildFundingReport,
  isThinHistory,
  MIN_USEFUL_SAMPLES,
} from './fundingCommand.js';

function makeStats(overrides: Partial<FundingStats> = {}): FundingStats {
  return {
    market: 'NVDA-USD',
    samples: 2160,
    spanHours: 2159,
    coveragePercent: 100,
    shortAprPercent: 6.94,
    negativeHoursPercent: 0.1,
    worstHourlyRate: -0.000077,
    bestHourlyRate: 0.000134,
    hourlyStdDev: 0.0000136,
    oldestSampleMs: 1_778_000_000_000,
    newestSampleMs: 1_786_000_000_000,
    ...overrides,
  };
}

function makeAnalysis(
  symbol: string,
  overrides: Partial<FundingStats> = {},
): FundingAnalysis {
  return {
    symbol,
    market: `${symbol}-USD`,
    stats: makeStats({market: `${symbol}-USD`, ...overrides}),
  };
}

describe('isThinHistory', () => {
  it('accepts a full, gapless window', () => {
    expect(isThinHistory(makeAnalysis('NVDA'))).toBe(false);
  });

  it('rejects a window with too few samples', () => {
    expect(
      isThinHistory(makeAnalysis('NEW', {samples: MIN_USEFUL_SAMPLES - 1})),
    ).toBe(true);
  });

  it('rejects a window that is long but full of gaps', () => {
    expect(isThinHistory(makeAnalysis('GAPPY', {coveragePercent: 40}))).toBe(
      true,
    );
  });

  it('rejects a symbol that could not be scored at all', () => {
    expect(
      isThinHistory({symbol: 'X', market: 'X-USD', error: 'timeout'}),
    ).toBe(true);
  });
});

describe('buildFundingReport', () => {
  it('ranks the best short carry first', () => {
    const report = buildFundingReport({
      analyses: [
        makeAnalysis('AAPL', {shortAprPercent: 4.12}),
        makeAnalysis('SNDK', {shortAprPercent: 9.57}),
        makeAnalysis('NVDA', {shortAprPercent: 6.94}),
      ],
      lookbackDays: 90,
    });

    const order = ['SNDK', 'NVDA', 'AAPL'].map(s => report.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps a thin history out of the ranking', () => {
    const report = buildFundingReport({
      analyses: [
        makeAnalysis('NVDA', {shortAprPercent: 6.94}),
        // A huge APR from six hours of data must not sort to the top.
        makeAnalysis('FRESH', {shortAprPercent: 99, samples: 6, spanHours: 5}),
      ],
      lookbackDays: 90,
    });

    expect(report).toContain('Not ranked');
    expect(report.indexOf('FRESH')).toBeGreaterThan(
      report.indexOf('Not ranked'),
    );
    expect(report.indexOf('NVDA')).toBeLessThan(report.indexOf('Not ranked'));
  });

  it('shows the failure reason for a symbol that could not be scored', () => {
    const report = buildFundingReport({
      analyses: [{symbol: 'X', market: 'X-USD', error: 'rate limited'}],
      lookbackDays: 90,
    });

    expect(report).toContain('rate limited');
  });

  it('omits the thin-history section when every symbol is usable', () => {
    const report = buildFundingReport({
      analyses: [makeAnalysis('NVDA')],
      lookbackDays: 90,
    });

    expect(report).not.toContain('Not ranked');
  });

  it('states the lookback window and that the carry is gross', () => {
    const report = buildFundingReport({
      analyses: [makeAnalysis('NVDA')],
      lookbackDays: 45,
    });

    expect(report).toContain('45 days');
    expect(report).toContain('gross carry');
  });

  it('warns when the exchange holds less history than was requested', () => {
    const report = buildFundingReport({
      // 46 days of hourly samples against a 90-day request.
      analyses: [makeAnalysis('NVDA', {samples: 1110, spanHours: 1109})],
      lookbackDays: 90,
    });

    expect(report).toContain('Only 46 days of funding history exist');
    expect(report).toContain('ex-dividend');
  });

  it('stays quiet when the requested window is actually covered', () => {
    const report = buildFundingReport({
      analyses: [makeAnalysis('NVDA', {samples: 2160, spanHours: 2159})],
      lookbackDays: 90,
    });

    expect(report).not.toContain('is not full');
  });

  it('does not warn on a shortfall smaller than a day', () => {
    const report = buildFundingReport({
      analyses: [makeAnalysis('NVDA', {samples: 2150, spanHours: 2149})],
      lookbackDays: 90,
    });

    expect(report).not.toContain('is not full');
  });

  it('renders a negative carry without losing the sign', () => {
    const report = buildFundingReport({
      analyses: [makeAnalysis('BAD', {shortAprPercent: -3.5})],
      lookbackDays: 90,
    });

    expect(report).toContain('-3.50');
  });
});
