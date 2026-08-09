/**
 * When is it worth closing a delta-neutral pair?
 *
 * A pair is long spot at `S0` and short perp at `P0`. Closing sells spot at
 * `S1` and buys the perp back at `P1`, so the price PnL is
 *
 *   (S1 - S0) + (P0 - P1)  =  (P0 - S0) - (P1 - S1)  =  B0 - B1
 *
 * where `B = perp - spot` is the **basis**. The two legs' directional moves
 * cancel exactly; what is left is basis convergence. So the pair makes money
 * on price when the basis *narrows* from where it was opened — which is the
 * whole reason to open at a premium — and loses when it widens, no matter what
 * the underlying did.
 *
 * Total realizable PnL adds the funding collected while held, and is measured
 * against exit prices that already include what it costs to get out: the spot
 * side from a real RFQ quote for the held size, the perp side from the price a
 * **taker** would pay. Using the taker price is deliberate conservatism — if
 * closing is profitable while crossing, it is certainly profitable resting.
 */

import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
  subtractDecimals,
} from '../perps/decimal.js';

export interface PairEntry {
  readonly symbol: string;
  /** Base units, positive: the size held long on spot and short on the perp. */
  readonly quantity: string;
  /** Average price the perp short was opened at. */
  readonly perpEntryPrice: string;
  /** USDG actually spent acquiring the spot leg, fees and impact included. */
  readonly spotCostUsdg: string;
}

export interface PairExitQuote {
  /** USDG a real quote says the spot leg would fetch right now. */
  readonly spotExitProceeds: string;
  /** Price the perp buy-back would pay as a taker — the conservative side. */
  readonly perpExitPrice: string;
  /** Funding collected so far. Positive means received. */
  readonly fundingEarned: string;
}

export interface CloseOpportunity {
  readonly symbol: string;
  readonly quantity: string;
  /** Proceeds minus cost on the spot leg. */
  readonly spotPnl: string;
  /** `(entry - exit) x quantity` on the short. */
  readonly perpPnl: string;
  readonly fundingEarned: string;
  /** Everything together: what closing right now would actually realize. */
  readonly netPnl: string;
  /** `netPnl` against the notional put to work, in basis points. */
  readonly netPnlBps: string;
  readonly entryBasis: string;
  readonly currentBasis: string;
  /** `entryBasis - currentBasis`. Positive means the basis narrowed. */
  readonly basisConvergence: string;
  /** True when `netPnlBps` clears the configured threshold. */
  readonly worthClosing: boolean;
}

/**
 * Values a pair at current prices and says whether closing clears
 * `minProfitBps`.
 *
 * `minProfitBps` may be negative, which is how a stop is expressed: a monitor
 * that must exit a decaying position sets it to the worst loss it will accept.
 */
export function evaluateClose(
  entry: PairEntry,
  quote: PairExitQuote,
  minProfitBps: number,
): CloseOpportunity {
  const spotPnl = subtractDecimals(quote.spotExitProceeds, entry.spotCostUsdg);
  const perpPnl = multiplyDecimals(
    subtractDecimals(entry.perpEntryPrice, quote.perpExitPrice),
    entry.quantity,
  );
  const netPnl = addDecimals(
    addDecimals(spotPnl, perpPnl),
    quote.fundingEarned,
  );

  const spotEntryPrice = divideDecimals(entry.spotCostUsdg, entry.quantity);
  const spotExitPrice = divideDecimals(quote.spotExitProceeds, entry.quantity);
  const entryBasis = subtractDecimals(entry.perpEntryPrice, spotEntryPrice);
  const currentBasis = subtractDecimals(quote.perpExitPrice, spotExitPrice);

  // Notional at entry is what the capital actually was.
  const netPnlBps = multiplyDecimals(
    divideDecimals(netPnl, entry.spotCostUsdg),
    '10000',
  );

  return {
    symbol: entry.symbol,
    quantity: entry.quantity,
    spotPnl,
    perpPnl,
    fundingEarned: quote.fundingEarned,
    netPnl,
    netPnlBps,
    entryBasis,
    currentBasis,
    basisConvergence: subtractDecimals(entryBasis, currentBasis),
    worthClosing: compareDecimals(netPnlBps, String(minProfitBps)) >= 0,
  };
}

/** One line per pair, aligned, for the monitor's periodic report. */
export function formatOpportunity(opportunity: CloseOpportunity): string {
  const cell = (value: string, width: number) => value.padStart(width);
  return [
    `  ${opportunity.symbol.padEnd(6)}`,
    cell(trim(opportunity.quantity, 8), 12),
    cell(trim(opportunity.spotPnl, 6), 10),
    cell(trim(opportunity.perpPnl, 6), 10),
    cell(trim(opportunity.fundingEarned, 8), 12),
    cell(trim(opportunity.netPnl, 6), 10),
    cell(trim(opportunity.netPnlBps, 2), 9),
    cell(trim(opportunity.basisConvergence, 4), 10),
    opportunity.worthClosing ? '  CLOSE' : '',
  ].join(' ');
}

export const OPPORTUNITY_HEADER = [
  `  ${'symbol'.padEnd(6)}`,
  'quantity'.padStart(12),
  'spotPnl'.padStart(10),
  'perpPnl'.padStart(10),
  'funding'.padStart(12),
  'netPnl'.padStart(10),
  'netBps'.padStart(9),
  'basisConv'.padStart(10),
].join(' ');

/** Fixed decimal places without going through a float. */
function trim(value: string, places: number): string {
  const [whole, fraction = ''] = value.split('.');
  if (places === 0) return whole ?? '0';
  return `${whole}.${fraction.padEnd(places, '0').slice(0, places)}`;
}
