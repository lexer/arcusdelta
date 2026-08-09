/**
 * The funding ranking's presentation logic, kept free of process/IO wiring so
 * the table and the warnings can be tested directly.
 */

import type {FundingAnalysis} from '../funding/fundingAnalyzer.js';
import {rankByShortCarry} from '../funding/fundingAnalyzer.js';

/**
 * Below this, a window has too few hours to say anything about the carry —
 * a fresh listing, or a market whose history the gateway has not backfilled.
 */
export const MIN_USEFUL_SAMPLES = 24 * 7;

/** Below this share of the expected hourly samples the history has real gaps. */
export const MIN_USEFUL_COVERAGE_PERCENT = 90;

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function formatRow(analysis: FundingAnalysis): string {
  const symbol = analysis.symbol.padEnd(6);
  if (analysis.stats === undefined) {
    return `  ${symbol} ${analysis.error ?? 'no data'}`;
  }

  const s = analysis.stats;
  return [
    `  ${symbol}`,
    pad(s.shortAprPercent.toFixed(2), 9),
    pad(String(s.samples), 7),
    pad(s.spanHours.toFixed(0), 7),
    pad(s.coveragePercent.toFixed(0), 6),
    pad(s.negativeHoursPercent.toFixed(1), 8),
    pad((s.hourlyStdDev * 1e6).toFixed(1), 9),
    pad((s.worstHourlyRate * 1e6).toFixed(1), 10),
  ].join(' ');
}

const HEADER = [
  `  ${'symbol'.padEnd(6)}`,
  pad('shortAPR%', 9),
  pad('samples', 7),
  pad('span_h', 7),
  pad('cov%', 6),
  pad('%neg_h', 8),
  pad('sd(1e-6)', 9),
  pad('worst(1e-6)', 10),
].join(' ');

/** True when the window is too short or too gappy to rank on. */
export function isThinHistory(analysis: FundingAnalysis): boolean {
  const stats = analysis.stats;
  if (stats === undefined) return true;
  return (
    stats.samples < MIN_USEFUL_SAMPLES ||
    stats.coveragePercent < MIN_USEFUL_COVERAGE_PERCENT
  );
}

export interface FundingReportOptions {
  readonly analyses: readonly FundingAnalysis[];
  readonly lookbackDays: number;
}

/**
 * Renders the ranking, best short carry first, with thin histories split into
 * their own section rather than mixed into the ranking — a 9% APR computed
 * from six hours of data would otherwise sort straight to the top.
 */
export function buildFundingReport(options: FundingReportOptions): string {
  const ranked = rankByShortCarry(options.analyses);
  const usable = ranked.filter(entry => !isThinHistory(entry));
  const thin = ranked.filter(isThinHistory);

  const lines = [
    '',
    `Funding history over the last ${options.lookbackDays} days, ranked by the`,
    'annualized carry a SHORT perp position would have collected.',
    '',
    HEADER,
    ...usable.map(formatRow),
  ];

  if (thin.length > 0) {
    lines.push(
      '',
      'Not ranked — too little history to judge:',
      ...thin.map(formatRow),
    );
  }

  lines.push(
    '',
    'shortAPR% is gross carry. It does not net out spot price impact, the perp',
    'taker fee when a chunk has to cross, or the cost of unwinding both legs.',
    'Past funding does not predict future funding: the SOFR-anchored base rate',
    'is stable, the premium on top of it is not.',
  );

  const shortfall = describeHistoryShortfall(ranked, options.lookbackDays);
  if (shortfall !== undefined) lines.push('', shortfall);

  lines.push('');
  return lines.join('\n');
}

/**
 * Says so when the exchange simply does not hold as much history as was asked
 * for.
 *
 * This matters more than it looks: dividends reach a perp as funding paid to
 * longs, so a short pays them. A window that spans no ex-dividend date shows a
 * carry that no one will actually earn over a full quarter, and the header
 * saying "last 90 days" would otherwise imply a quarter was measured.
 */
function describeHistoryShortfall(
  ranked: readonly FundingAnalysis[],
  lookbackDays: number,
): string | undefined {
  const spans = ranked
    .map(entry => entry.stats?.spanHours)
    .filter((span): span is number => span !== undefined && span > 0);
  if (spans.length === 0) return undefined;

  const longestDays = Math.max(...spans) / 24;
  // A day of slack: the newest funding hour is up to an hour old.
  if (longestDays >= lookbackDays - 1) return undefined;

  return (
    `Only ${longestDays.toFixed(0)} days of funding history exist — the ` +
    `${lookbackDays}-day window is not full.\n` +
    'A window this short may span no ex-dividend date, and dividends are paid\n' +
    'by the short through funding. Treat these figures as an upper bound.'
  );
}
