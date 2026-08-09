/**
 * Turns a market's funding history into the numbers that decide whether it is
 * worth pairing.
 *
 * A short earns funding when the rate is positive, so the headline figure is
 * the **annualized carry a short would have collected** over the lookback
 * window. Everything else on {@link FundingStats} exists to stop that one
 * number from being read naively — a high mean built out of a few violent
 * hours is a different asset than a steady drip, and a window with too few
 * samples is not evidence at all.
 *
 * Scoring is pure and separated from fetching: the paginated walk in
 * {@link FundingHistoryFetcher} is the part that has to respect rate limits,
 * and the arithmetic is the part that has to be right.
 */

import type {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import type {FundingRateSample} from '../perps/types.js';

const HOURS_PER_YEAR = 24 * 365;
const MICROS_PER_MS = 1_000;
const MS_PER_HOUR = 3_600_000;
/** The gateway clamps `limit` here, so a wider window has to be paged. */
const MAX_PAGE_SIZE = 1000;
/** Guards against a pathological page loop if the gateway stops advancing. */
const MAX_PAGES = 50;

export interface FundingStats {
  readonly market: string;
  readonly samples: number;
  /** Hours between the oldest and newest sample. */
  readonly spanHours: number;
  /**
   * Samples present as a share of the hours spanned. Well under 100% means
   * the history has gaps and the annualized figure rests on thin evidence.
   */
  readonly coveragePercent: number;
  /** Annualized carry a short collects, percent. The ranking key. */
  readonly shortAprPercent: number;
  /** Share of hours where the rate was negative — the short paid. */
  readonly negativeHoursPercent: number;
  /** Most negative hourly rate seen: the worst single hour for a short. */
  readonly worstHourlyRate: number;
  readonly bestHourlyRate: number;
  /** Population standard deviation of the hourly rate. */
  readonly hourlyStdDev: number;
  /** Epoch ms of the oldest and newest sample, or undefined with no samples. */
  readonly oldestSampleMs: number | undefined;
  readonly newestSampleMs: number | undefined;
}

/** `time` is epoch **microseconds** on the wire; every window here is ms. */
function sampleMs(sample: FundingRateSample): number {
  return Math.floor(sample.time / MICROS_PER_MS);
}

/**
 * Annualizes the mean hourly rate.
 *
 * Uses the mean rather than compounding: funding is paid out as cash against
 * a position that is not itself reinvested, so the simple annualization is
 * the honest one. Float is fine here — these are statistics for ranking and
 * display, never an amount that sizes an order.
 */
export function scoreFundingHistory(
  market: string,
  samples: readonly FundingRateSample[],
): FundingStats {
  if (samples.length === 0) {
    return {
      market,
      samples: 0,
      spanHours: 0,
      coveragePercent: 0,
      shortAprPercent: 0,
      negativeHoursPercent: 0,
      worstHourlyRate: 0,
      bestHourlyRate: 0,
      hourlyStdDev: 0,
      oldestSampleMs: undefined,
      newestSampleMs: undefined,
    };
  }

  const rates = samples.map(sample => Number(sample.fundingRate));
  const times = samples.map(sampleMs);
  const oldestSampleMs = Math.min(...times);
  const newestSampleMs = Math.max(...times);

  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const variance =
    rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / rates.length;

  // One sample spans zero hours but still represents an hour of funding.
  const spanHours = (newestSampleMs - oldestSampleMs) / MS_PER_HOUR;
  const expectedSamples = spanHours + 1;

  return {
    market,
    samples: samples.length,
    spanHours,
    coveragePercent: (samples.length / expectedSamples) * 100,
    shortAprPercent: mean * HOURS_PER_YEAR * 100,
    negativeHoursPercent:
      (rates.filter(rate => rate < 0).length / rates.length) * 100,
    worstHourlyRate: Math.min(...rates),
    bestHourlyRate: Math.max(...rates),
    hourlyStdDev: Math.sqrt(variance),
    oldestSampleMs,
    newestSampleMs,
  };
}

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface FundingHistoryFetcherOptions {
  readonly client: Pick<ArcusPerpsClient, 'getFundingRates'>;
  /**
   * Delay between pages. `fundingRates` costs 20 weight against a bucket
   * refilling at 25/second, so a wide scan without this spends the whole
   * per-minute budget in seconds and gets throttled.
   */
  readonly requestIntervalMs: number;
  readonly sleep?: Sleep;
  /** Injected so tests are not tied to the wall clock. */
  readonly now?: () => number;
}

/**
 * Walks `GET /v1/fundingRates` backwards until the lookback window is covered.
 *
 * The endpoint returns newest-first and caps a page at 1000 rows (~41 days of
 * hourly funding), so a 90-day window is three pages. Each page after the
 * first ends one millisecond before the oldest row already seen, which is what
 * keeps the pages from overlapping — `to` is inclusive.
 */
export class FundingHistoryFetcher {
  private readonly client: Pick<ArcusPerpsClient, 'getFundingRates'>;
  private readonly requestIntervalMs: number;
  private readonly sleep: Sleep;
  private readonly now: () => number;

  constructor(options: FundingHistoryFetcherOptions) {
    this.client = options.client;
    this.requestIntervalMs = options.requestIntervalMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  async fetch(
    market: string,
    lookbackDays: number,
  ): Promise<FundingRateSample[]> {
    const now = this.now();
    const from = now - lookbackDays * 24 * MS_PER_HOUR;

    const collected: FundingRateSample[] = [];
    let to = now;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && this.requestIntervalMs > 0) {
        await this.sleep(this.requestIntervalMs);
      }

      const rates = await this.client.getFundingRates({
        market,
        from,
        to,
        limit: MAX_PAGE_SIZE,
      });
      if (rates.length === 0) break;

      collected.push(...rates);

      // A short page means the window is exhausted — there is nothing older
      // between `from` and this page's oldest row.
      if (rates.length < MAX_PAGE_SIZE) break;

      const oldest = Math.min(...rates.map(sampleMs));
      if (oldest <= from) break;
      to = oldest - 1;
    }

    return collected;
  }
}

/** One symbol's outcome: either stats, or why it could not be scored. */
export interface FundingAnalysis {
  readonly symbol: string;
  readonly market: string;
  readonly stats?: FundingStats;
  readonly error?: string;
}

export interface AnalyzeOptions {
  readonly markets: ReadonlyArray<{symbol: string; market: string}>;
  readonly lookbackDays: number;
  readonly fetcher: Pick<FundingHistoryFetcher, 'fetch'>;
  /** Called after each symbol so a long scan can report progress. */
  readonly onProgress?: (done: number, total: number, symbol: string) => void;
}

/**
 * Scores every market in sequence.
 *
 * Sequential on purpose: the per-IP weight budget is shared across the whole
 * scan, and firing these in parallel just converts the pacing into 429s.
 * One symbol failing does not abandon the rest — a partial ranking is still
 * useful, and the failure is reported per symbol.
 */
export async function analyzeFunding(
  options: AnalyzeOptions,
): Promise<FundingAnalysis[]> {
  const results: FundingAnalysis[] = [];

  for (const [index, entry] of options.markets.entries()) {
    try {
      const samples = await options.fetcher.fetch(
        entry.market,
        options.lookbackDays,
      );
      results.push({
        symbol: entry.symbol,
        market: entry.market,
        stats: scoreFundingHistory(entry.market, samples),
      });
    } catch (error) {
      results.push({
        symbol: entry.symbol,
        market: entry.market,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    options.onProgress?.(index + 1, options.markets.length, entry.symbol);
  }

  return results;
}

/** Best short carry first; symbols that could not be scored last. */
export function rankByShortCarry(
  analyses: readonly FundingAnalysis[],
): FundingAnalysis[] {
  return [...analyses].sort((a, b) => {
    if (a.stats === undefined && b.stats === undefined) return 0;
    if (a.stats === undefined) return 1;
    if (b.stats === undefined) return -1;
    return b.stats.shortAprPercent - a.stats.shortAprPercent;
  });
}
