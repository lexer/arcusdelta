/**
 * An append-only record of everything this bot actually executed, plus the
 * funding it collected.
 *
 * Distinct from the run log: the run log is for debugging a flow, this is for
 * answering "what did we trade, at what price, and what has the carry paid so
 * far". One JSON object per line, so it is greppable, tail-able, and readable
 * by anything without a parser.
 *
 * **This is a record, not a source of truth.** The PnL path deliberately
 * reconstructs from chain logs and the exchange API rather than trusting a
 * local file, because the wallet gets used outside the bot and a local ledger
 * silently drifts. The journal exists alongside that: it captures intent and
 * execution detail the reconstruction cannot recover (which chunk, which
 * attempt, what the quote promised), and it is safe to delete.
 *
 * Writes are synchronous. These events are low-frequency and each one marks
 * real money moving, so a crash immediately after a fill must not lose the
 * record of it.
 */

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname} from 'node:path';

/** A perp order that filled, in whole or in part. */
export interface PerpFillEvent {
  readonly kind: 'perp-fill';
  readonly at: string;
  readonly tradeId: string;
  readonly symbol: string;
  readonly market: string;
  readonly marketId: number;
  readonly side: 'BUY' | 'SELL';
  readonly orderId: string;
  readonly clientId?: string;
  /** Base units filled. */
  readonly filledQuantity: string;
  readonly requestedQuantity: string;
  readonly limitPrice: string;
  readonly averageFillPrice?: string;
  readonly timeInForce: string;
  readonly reduceOnly: boolean;
  /** False when the order crossed — i.e. paid the taker fee. */
  readonly maker: boolean;
  /** Re-price attempts spent before this fill. */
  readonly attempts?: number;
}

/** A spot trade settled on Arcus. */
export interface SpotFillEvent {
  readonly kind: 'spot-fill';
  readonly at: string;
  readonly tradeId: string;
  readonly symbol: string;
  readonly direction: 'buy' | 'sell';
  readonly sellSymbol: string;
  readonly buySymbol: string;
  /** Atomic units, as the router reports them. */
  readonly sellAmount: string;
  readonly buyAmount: string;
  readonly txHashes: readonly string[];
}

/**
 * One hourly funding payment, mirrored from `GET /v1/funding`.
 * `payment` is signed: positive means the account received it.
 */
export interface FundingEvent {
  readonly kind: 'funding';
  readonly at: string;
  readonly symbol: string;
  readonly market: string;
  readonly marketId: number;
  readonly fundingRate: string;
  /** Signed position size when the payment was computed. */
  readonly size: string;
  readonly payment: string;
  /** Exchange payment time, epoch microseconds — the dedup key with market. */
  readonly paymentTime: number;
}

export type ExecutionEvent = PerpFillEvent | SpotFillEvent | FundingEvent;

export interface ExecutionJournal {
  record(event: ExecutionEvent): void;
  /** Every event ever recorded, oldest first. */
  read(): ExecutionEvent[];
}

/**
 * A journal that discards everything.
 *
 * The default in tests and under `--dry-run`: a rehearsal must not leave
 * entries that later read as real fills.
 */
export function createNullJournal(): ExecutionJournal {
  return {
    record: () => {},
    read: () => [],
  };
}

export function createFileJournal(path: string): ExecutionJournal {
  return {
    record(event: ExecutionEvent): void {
      mkdirSync(dirname(path), {recursive: true});
      appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
    },

    read(): ExecutionEvent[] {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        // No journal yet is not an error — nothing has been executed.
        return [];
      }
      return raw
        .split('\n')
        .filter(line => line.trim() !== '')
        .flatMap(line => {
          try {
            return [JSON.parse(line) as ExecutionEvent];
          } catch {
            // One torn line (a crash mid-append) must not make the rest
            // unreadable.
            return [];
          }
        });
    },
  };
}

/** Total funding received minus paid, across every recorded payment. */
export function totalFunding(
  events: readonly ExecutionEvent[],
  symbol?: string,
): number {
  return events
    .filter(
      (event): event is FundingEvent =>
        event.kind === 'funding' &&
        (symbol === undefined || event.symbol === symbol),
    )
    .reduce((sum, event) => sum + Number(event.payment), 0);
}

/**
 * Newest funding payment time already recorded, per market id.
 *
 * This is what makes the funding sync idempotent: the exchange serves the same
 * hourly payments on every call, and re-recording them would double-count the
 * carry.
 */
export function latestFundingTimeByMarket(
  events: readonly ExecutionEvent[],
): Map<number, number> {
  const latest = new Map<number, number>();
  for (const event of events) {
    if (event.kind !== 'funding') continue;
    const seen = latest.get(event.marketId);
    if (seen === undefined || event.paymentTime > seen) {
      latest.set(event.marketId, event.paymentTime);
    }
  }
  return latest;
}
