/**
 * Unwinds a delta-neutral pair, one chunk at a time.
 *
 * The mirror of the open, inverted. Per chunk: buy the perp back as a
 * **reduce-only post-only** order, then sell the matching size of spot. Delta
 * returns to zero at the end of every chunk rather than only at the end of the
 * whole unwind, so an interruption at any point leaves a smaller, hedged
 * position rather than a half-closed one.
 *
 * Why chunked at all: a single resting order for the full position advertises
 * the whole size into a book that may trade a few times an hour, and is
 * unlikely to fill whole. Chunking gets the same maker economics in pieces the
 * book can actually absorb.
 *
 * Direction of the exposure window. Between the perp buy-back and the spot
 * sell the account is net **long** by one chunk. That is the safer side to be
 * caught on than the open's net-short window: a spot long is unleveraged and
 * cannot be liquidated. So a failed spot sell stops the unwind and reports —
 * it does not cross the spread to fix itself.
 */

import type {Hex} from 'viem';
import type {BuyResult, SellRequest} from '../arcus/types.js';
import {
  spotFillEvent,
  type ExecutionJournal,
} from '../journal/executionJournal.js';
import type {Logger} from '../logging/logger.js';
import {
  absDecimals,
  addDecimals,
  compareDecimals,
  divideDecimals,
  floorToIncrement,
  isPositive,
  multiplyDecimals,
  subtractDecimals,
} from '../perps/decimal.js';
import type {MakerOrderResult} from '../perps/makerOrderExecutor.js';
import type {PerpsShortService} from '../perps/perpsShortService.js';
import type {MarketSpec} from '../perps/types.js';

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Token metadata for the spot leg. */
export interface SpotLeg {
  readonly address: Hex;
  readonly decimals: number;
}

export interface ClosePairRequest {
  readonly tradeId: string;
  readonly symbol: string;
  readonly spec: MarketSpec;
  readonly spot: SpotLeg;
  /** Total base units to unwind. Usually the whole position. */
  readonly quantity: string;
  readonly chunks: number;
  readonly intervalSeconds: number;
  readonly repriceSeconds: number;
  readonly maxAttempts: number;
  readonly improveTicks?: number;
  /** Slippage tolerance on the spot sell. */
  readonly slippageBps: number;
}

export interface ChunkOutcome {
  readonly chunk: number;
  readonly perpClosed: string;
  readonly perpPrice: string | undefined;
  readonly spotSoldAtoms: string;
  readonly spotProceeds: string;
  readonly txHashes: readonly Hex[];
}

export interface ClosePairResult {
  readonly symbol: string;
  readonly perpClosed: string;
  readonly spotSoldAtoms: string;
  readonly chunks: readonly ChunkOutcome[];
  /** True when the whole requested quantity was unwound on both legs. */
  readonly complete: boolean;
  /** Why it stopped early, when it did. */
  readonly stoppedBecause?: string;
}

export interface PairCloseServiceOptions {
  readonly shorts: Pick<PerpsShortService, 'closeShort' | 'positionFor'>;
  readonly spotSeller: {executeSell(request: SellRequest): Promise<BuyResult>};
  readonly readSpotBalanceAtoms: () => Promise<bigint>;
  readonly journal: ExecutionJournal;
  readonly logger: Logger;
  readonly sleep?: Sleep;
}

/**
 * Splits a total into `chunks` pieces aligned to `stepSize`, the last taking
 * the remainder so the sum is exactly the total.
 *
 * A chunk that rounds to zero would post an invalid order, so the count is
 * reduced until every piece is placeable.
 */
export function splitQuantity(
  total: string,
  chunks: number,
  stepSize: string,
): string[] {
  for (let count = Math.max(1, chunks); count >= 1; count--) {
    const base = floorToIncrement(
      divideDecimals(total, String(count)),
      stepSize,
    );
    if (!isPositive(base)) continue;
    const pieces = new Array<string>(count - 1).fill(base);
    // The last piece takes the remainder, so the sum is exactly the total
    // however the floor rounded the others.
    const last = subtractDecimals(
      total,
      multiplyDecimals(base, String(count - 1)),
    );
    if (!isPositive(last)) continue;
    pieces.push(last);
    return pieces;
  }
  return [total];
}

export class PairCloseService {
  private readonly options: PairCloseServiceOptions;
  private readonly sleep: Sleep;

  constructor(options: PairCloseServiceOptions) {
    this.options = options;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async close(request: ClosePairRequest): Promise<ClosePairResult> {
    const log = this.options.logger.child({
      tradeId: request.tradeId,
      symbol: request.symbol,
      market: request.spec.market,
    });
    const pieces = splitQuantity(
      request.quantity,
      request.chunks,
      request.spec.stepSize,
    );
    log.info(
      {quantity: request.quantity, chunks: pieces.length, pieces},
      'pair close started',
    );

    const outcomes: ChunkOutcome[] = [];
    let perpClosed = '0';
    let spotSoldAtoms = 0n;
    let stoppedBecause: string | undefined;

    for (const [index, piece] of pieces.entries()) {
      const chunk = index + 1;
      const chunkLog = log.child({chunk, of: pieces.length});

      // 1. Perp first: reduce-only, post-only. Never crosses.
      let closed: MakerOrderResult;
      try {
        closed = await this.options.shorts.closeShort({
          tradeId: `${request.tradeId}-${chunk}`,
          symbol: request.symbol,
          spec: request.spec,
          quantity: piece,
          repriceSeconds: request.repriceSeconds,
          maxAttempts: request.maxAttempts,
          ...(request.improveTicks === undefined
            ? {}
            : {improveTicks: request.improveTicks}),
        });
      } catch (error) {
        stoppedBecause = `perp buy-back failed on chunk ${chunk}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        chunkLog.error({error: stoppedBecause}, 'pair close stopped');
        break;
      }

      if (!isPositive(closed.filledQuantity)) {
        stoppedBecause =
          `chunk ${chunk} did not fill as a maker after ` +
          `${closed.attempts} attempts — nothing was sold, the pair is ` +
          'still hedged';
        chunkLog.warn({attempts: closed.attempts}, 'pair close stalled');
        break;
      }
      perpClosed = addDecimals(perpClosed, closed.filledQuantity);

      // 2. Spot second, matching what actually closed on the perp. Between
      //    these two the account is net long by this chunk.
      const wanted = toAtoms(closed.filledQuantity, request.spot.decimals);
      const available = await this.options.readSpotBalanceAtoms();
      const sellAtoms = wanted < available ? wanted : available;

      if (sellAtoms <= 0n) {
        stoppedBecause = `no spot balance to sell against chunk ${chunk}`;
        chunkLog.error({wanted: wanted.toString()}, 'pair close stopped');
        break;
      }

      let sold: BuyResult;
      try {
        sold = await this.options.spotSeller.executeSell({
          tradeId: `${request.tradeId}-${chunk}`,
          sellToken: request.spot.address,
          sellAmountAtoms: sellAtoms,
          slippageBps: request.slippageBps,
        });
      } catch (error) {
        // Net long by one chunk. Unleveraged and unliquidatable, so stopping
        // and reporting beats crossing the spread to force a fix.
        stoppedBecause =
          `spot sell failed on chunk ${chunk} after the perp was bought ` +
          `back — the account is net LONG ${closed.filledQuantity} ` +
          `${request.symbol}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        chunkLog.error({error: stoppedBecause}, 'pair close stopped net long');
        break;
      }

      this.options.journal.record(
        spotFillEvent({
          tradeId: request.tradeId,
          symbol: request.symbol,
          direction: 'sell',
          sellSymbol: request.symbol,
          buySymbol: 'USDG',
          sellAmountAtoms: sold.sellAmount,
          sellDecimals: request.spot.decimals,
          buyAmountAtoms: sold.buyAmount,
          buyDecimals: USDG_DECIMALS,
          txHashes: sold.txHashes,
        }),
      );
      spotSoldAtoms += sellAtoms;

      outcomes.push({
        chunk,
        perpClosed: closed.filledQuantity,
        perpPrice: closed.averageFillPrice,
        spotSoldAtoms: sellAtoms.toString(),
        spotProceeds: sold.buyAmount,
        txHashes: sold.txHashes,
      });
      chunkLog.info(
        {
          perpClosed: closed.filledQuantity,
          perpPrice: closed.averageFillPrice,
          spotSold: sellAtoms.toString(),
          proceeds: sold.buyAmount,
        },
        'chunk unwound, delta back to flat',
      );

      if (chunk < pieces.length) {
        await this.sleep(request.intervalSeconds * 1000);
      }
    }

    const complete =
      stoppedBecause === undefined &&
      compareDecimals(perpClosed, request.quantity) >= 0;

    const result: ClosePairResult = {
      symbol: request.symbol,
      perpClosed,
      spotSoldAtoms: spotSoldAtoms.toString(),
      chunks: outcomes,
      complete,
      ...(stoppedBecause === undefined ? {} : {stoppedBecause}),
    };
    log.info({...result, chunks: outcomes.length}, 'pair close finished');
    return result;
  }

  /** Base units still short in this market, or `0` when flat. */
  async remainingShort(market: string): Promise<string> {
    const position = await this.options.shorts.positionFor(market);
    if (position === undefined || position.side !== 'SHORT') return '0';
    return absDecimals(position.size);
  }
}

const USDG_DECIMALS = 6;

function toAtoms(value: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals));
}
