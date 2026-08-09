import {describe, expect, it, vi} from 'vitest';
import type {FundingRateSample} from '../perps/types.js';
import {
  analyzeFunding,
  FundingHistoryFetcher,
  rankByShortCarry,
  scoreFundingHistory,
} from './fundingAnalyzer.js';

const HOUR_MICROS = 3_600_000_000;
const BASE_TIME_MICROS = 1_786_269_600_000_000;

/** `count` hourly samples ending at `BASE_TIME_MICROS`, newest first. */
function makeSamples(
  rates: readonly number[] | number,
  count?: number,
): FundingRateSample[] {
  const list =
    typeof rates === 'number'
      ? new Array<number>(count ?? 1).fill(rates)
      : rates;
  return list.map((rate, index) => ({
    marketId: 28,
    marketDisplayName: 'NVDA-USD',
    fundingRate: String(rate),
    time: BASE_TIME_MICROS - index * HOUR_MICROS,
  }));
}

describe('scoreFundingHistory', () => {
  it('annualizes the mean hourly rate as the short carry', () => {
    // 0.00001/hr * 24 * 365 = 8.76% a year.
    const stats = scoreFundingHistory('NVDA-USD', makeSamples(0.00001, 100));

    expect(stats.shortAprPercent).toBeCloseTo(8.76, 10);
    expect(stats.samples).toBe(100);
  });

  it('produces a negative carry when the short is the one paying', () => {
    const stats = scoreFundingHistory('NVDA-USD', makeSamples(-0.00001, 10));

    expect(stats.shortAprPercent).toBeCloseTo(-8.76, 10);
    expect(stats.negativeHoursPercent).toBe(100);
  });

  it('reports the share of hours the short paid', () => {
    const stats = scoreFundingHistory(
      'NVDA-USD',
      makeSamples([0.001, 0.001, -0.001, 0]),
    );

    // Zero is not negative — the short paid nothing that hour.
    expect(stats.negativeHoursPercent).toBe(25);
  });

  it('reports the worst and best single hour', () => {
    const stats = scoreFundingHistory(
      'NVDA-USD',
      makeSamples([0.002, -0.005, 0.001]),
    );

    expect(stats.worstHourlyRate).toBe(-0.005);
    expect(stats.bestHourlyRate).toBe(0.002);
  });

  it('separates a steady carry from a spiky one with the same mean', () => {
    const steady = scoreFundingHistory('A-USD', makeSamples([0.001, 0.001]));
    const spiky = scoreFundingHistory('B-USD', makeSamples([0.002, 0]));

    expect(spiky.shortAprPercent).toBeCloseTo(steady.shortAprPercent, 10);
    expect(steady.hourlyStdDev).toBe(0);
    expect(spiky.hourlyStdDev).toBeGreaterThan(0);
  });

  it('reports full coverage for a gapless hourly window', () => {
    const stats = scoreFundingHistory('NVDA-USD', makeSamples(0.00001, 24));

    expect(stats.spanHours).toBe(23);
    expect(stats.coveragePercent).toBe(100);
  });

  it('reports reduced coverage when hours are missing', () => {
    // Two samples 10 hours apart: 2 of an expected 11.
    const stats = scoreFundingHistory('NVDA-USD', [
      ...makeSamples([0.001]),
      {
        marketId: 28,
        marketDisplayName: 'NVDA-USD',
        fundingRate: '0.001',
        time: BASE_TIME_MICROS - 10 * HOUR_MICROS,
      },
    ]);

    expect(stats.spanHours).toBe(10);
    expect(stats.coveragePercent).toBeCloseTo((2 / 11) * 100, 10);
  });

  it('converts the microsecond wire timestamps to milliseconds', () => {
    const stats = scoreFundingHistory('NVDA-USD', makeSamples(0.001, 2));

    expect(stats.newestSampleMs).toBe(BASE_TIME_MICROS / 1000);
    expect(stats.oldestSampleMs).toBe(BASE_TIME_MICROS / 1000 - 3_600_000);
  });

  it('returns a zeroed, sample-free result for an empty history', () => {
    const stats = scoreFundingHistory('NEW-USD', []);

    expect(stats.samples).toBe(0);
    expect(stats.shortAprPercent).toBe(0);
    expect(stats.oldestSampleMs).toBeUndefined();
  });
});

describe('FundingHistoryFetcher', () => {
  const now = () => BASE_TIME_MICROS / 1000;

  function makeFetcher(pages: FundingRateSample[][]) {
    const getFundingRates = vi.fn();
    for (const page of pages) getFundingRates.mockResolvedValueOnce(page);
    getFundingRates.mockResolvedValue([]);
    const slept: number[] = [];
    const fetcher = new FundingHistoryFetcher({
      client: {getFundingRates},
      requestIntervalMs: 1000,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      now,
    });
    return {fetcher, getFundingRates, slept};
  }

  it('bounds the first page by the lookback window', async () => {
    const {fetcher, getFundingRates} = makeFetcher([makeSamples(0.001, 5)]);

    await fetcher.fetch('NVDA-USD', 90);

    expect(getFundingRates).toHaveBeenCalledWith({
      market: 'NVDA-USD',
      from: now() - 90 * 24 * 3_600_000,
      to: now(),
      limit: 1000,
    });
  });

  it('stops after a short page', async () => {
    const {fetcher, getFundingRates} = makeFetcher([makeSamples(0.001, 5)]);

    const samples = await fetcher.fetch('NVDA-USD', 90);

    expect(samples).toHaveLength(5);
    expect(getFundingRates).toHaveBeenCalledTimes(1);
  });

  it('pages backwards from one millisecond before the oldest row seen', async () => {
    const first = makeSamples(0.001, 1000);
    const {fetcher, getFundingRates} = makeFetcher([
      first,
      makeSamples(0.001, 3),
    ]);

    await fetcher.fetch('NVDA-USD', 90);

    const oldestFirstPageMs = Math.min(...first.map(s => s.time / 1000));
    expect(getFundingRates).toHaveBeenNthCalledWith(2, {
      market: 'NVDA-USD',
      from: now() - 90 * 24 * 3_600_000,
      to: oldestFirstPageMs - 1,
      limit: 1000,
    });
  });

  it('accumulates every page into one history', async () => {
    const {fetcher} = makeFetcher([
      makeSamples(0.001, 1000),
      makeSamples(0.001, 7),
    ]);

    expect(await fetcher.fetch('NVDA-USD', 90)).toHaveLength(1007);
  });

  it('paces between pages but not before the first request', async () => {
    const {fetcher, slept} = makeFetcher([
      makeSamples(0.001, 1000),
      makeSamples(0.001, 2),
    ]);

    await fetcher.fetch('NVDA-USD', 90);

    expect(slept).toEqual([1000]);
  });

  it('returns nothing for a market with no history', async () => {
    const {fetcher} = makeFetcher([[]]);

    expect(await fetcher.fetch('NEW-USD', 90)).toEqual([]);
  });
});

describe('analyzeFunding', () => {
  const markets = [
    {symbol: 'NVDA', market: 'NVDA-USD'},
    {symbol: 'AAPL', market: 'AAPL-USD'},
  ];

  it('scores every market', async () => {
    const fetcher = {
      fetch: vi.fn().mockResolvedValue(makeSamples(0.00001, 10)),
    };

    const results = await analyzeFunding({markets, lookbackDays: 90, fetcher});

    expect(results.map(r => r.symbol)).toEqual(['NVDA', 'AAPL']);
    expect(results[0]!.stats!.shortAprPercent).toBeCloseTo(8.76, 10);
  });

  it('records a per-symbol failure and keeps going', async () => {
    const fetcher = {
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValueOnce(makeSamples(0.00001, 10)),
    };

    const results = await analyzeFunding({markets, lookbackDays: 90, fetcher});

    expect(results[0]!.error).toBe('rate limited');
    expect(results[0]!.stats).toBeUndefined();
    expect(results[1]!.stats).toBeDefined();
  });

  it('reports progress as it goes', async () => {
    const fetcher = {fetch: vi.fn().mockResolvedValue([])};
    const onProgress = vi.fn();

    await analyzeFunding({markets, lookbackDays: 90, fetcher, onProgress});

    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, 'NVDA');
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, 'AAPL');
  });

  it('scans sequentially rather than firing every market at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher = {
      fetch: async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await Promise.resolve();
        inFlight--;
        return [];
      },
    };

    await analyzeFunding({markets, lookbackDays: 90, fetcher});

    expect(maxInFlight).toBe(1);
  });
});

describe('rankByShortCarry', () => {
  it('sorts the best short carry first', () => {
    const ranked = rankByShortCarry([
      {
        symbol: 'A',
        market: 'A-USD',
        stats: scoreFundingHistory('A-USD', makeSamples(0.00001, 5)),
      },
      {
        symbol: 'B',
        market: 'B-USD',
        stats: scoreFundingHistory('B-USD', makeSamples(0.00003, 5)),
      },
    ]);

    expect(ranked.map(r => r.symbol)).toEqual(['B', 'A']);
  });

  it('puts unscorable symbols last', () => {
    const ranked = rankByShortCarry([
      {symbol: 'BROKEN', market: 'BROKEN-USD', error: 'timeout'},
      {
        symbol: 'A',
        market: 'A-USD',
        stats: scoreFundingHistory('A-USD', makeSamples(-0.001, 5)),
      },
    ]);

    expect(ranked.map(r => r.symbol)).toEqual(['A', 'BROKEN']);
  });
});
