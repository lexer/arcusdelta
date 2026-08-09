/**
 * Mirrors realized funding payments from the exchange into the journal.
 *
 * The exchange is the authority — it serves the same hourly payments on every
 * call — so the only job here is to append each one exactly once. Dedup is by
 * `(marketId, paymentTime)` read back from the journal, not by remembering a
 * cursor: a cursor in a separate file is one more thing that can disagree with
 * the record it is supposed to describe.
 *
 * Only markets the strategy actually holds are recorded. The wallet carries
 * positions this bot did not open (see the guards in plan 0011), and their
 * funding is not this strategy's carry.
 */

import type {Logger} from '../logging/logger.js';
import type {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import type {FundingPayment} from '../perps/types.js';
import {
  latestFundingTimeByMarket,
  type ExecutionJournal,
  type FundingEvent,
} from './executionJournal.js';

const MICROS_PER_MS = 1_000;
const MS_PER_DAY = 86_400_000;
/** How far back to look on a journal with no funding history yet. */
const DEFAULT_BACKFILL_DAYS = 30;

export interface FundingRecorderOptions {
  readonly client: Pick<ArcusPerpsClient, 'getFundingPayments'>;
  readonly journal: ExecutionJournal;
  readonly logger: Logger;
  readonly address: string;
  readonly accountIndex: number;
  readonly now?: () => number;
}

export interface SyncResult {
  readonly recorded: number;
  readonly skipped: number;
  /** Sum of the payments recorded by this call. Positive means received. */
  readonly recordedTotal: number;
}

/** Maps market name to the symbol the strategy knows it by, e.g. NVDA-USD -> NVDA. */
export type SymbolResolver = (market: string) => string | undefined;

export class FundingRecorder {
  private readonly client: FundingRecorderOptions['client'];
  private readonly journal: ExecutionJournal;
  private readonly logger: Logger;
  private readonly address: string;
  private readonly accountIndex: number;
  private readonly now: () => number;

  constructor(options: FundingRecorderOptions) {
    this.client = options.client;
    this.journal = options.journal;
    this.logger = options.logger;
    this.address = options.address;
    this.accountIndex = options.accountIndex;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Appends every funding payment not already recorded, for the markets
   * `resolveSymbol` recognizes.
   *
   * Safe to call repeatedly — that is the point. The monitor calls it on each
   * pass, and a duplicate run adds nothing.
   */
  async sync(resolveSymbol: SymbolResolver): Promise<SyncResult> {
    const existing = this.journal.read();
    const latestByMarket = latestFundingTimeByMarket(existing);

    const to = this.now();
    // Start from the oldest market's cursor so one newly-added symbol does not
    // drag the window back for everything, but nothing is missed either.
    const cursors = [...latestByMarket.values()];
    const from =
      cursors.length === 0
        ? to - DEFAULT_BACKFILL_DAYS * MS_PER_DAY
        : Math.floor(Math.min(...cursors) / MICROS_PER_MS);

    const payments = await this.client.getFundingPayments({
      address: this.address,
      accountIndex: this.accountIndex,
      from,
      to,
    });

    let recorded = 0;
    let skipped = 0;
    let recordedTotal = 0;

    // Oldest first, so the journal reads chronologically.
    for (const payment of [...payments].reverse()) {
      const symbol = resolveSymbol(payment.marketDisplayName);
      if (symbol === undefined) {
        skipped++;
        continue;
      }

      const seen = latestByMarket.get(payment.marketId);
      if (seen !== undefined && payment.time <= seen) {
        skipped++;
        continue;
      }

      this.journal.record(toFundingEvent(payment, symbol, this.now()));
      recorded++;
      recordedTotal += Number(payment.payment);
    }

    this.logger.info(
      {
        recorded,
        skipped,
        recordedTotal,
        from,
        to,
        markets: [...latestByMarket.keys()],
      },
      'funding payments synced',
    );
    return {recorded, skipped, recordedTotal};
  }
}

function toFundingEvent(
  payment: FundingPayment,
  symbol: string,
  nowMs: number,
): FundingEvent {
  return {
    kind: 'funding',
    at: new Date(nowMs).toISOString(),
    symbol,
    market: payment.marketDisplayName,
    marketId: payment.marketId,
    fundingRate: payment.fundingRate,
    size: payment.size,
    payment: payment.payment,
    paymentTime: payment.time,
  };
}
