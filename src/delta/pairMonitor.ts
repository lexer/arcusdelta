/**
 * Watches open pairs and reports when closing one would realize a profit.
 *
 * The signal is basis convergence, not price direction — see
 * `closeOpportunity.ts` for why the two legs' directional moves cancel and
 * only `B0 - B1` survives. A pair opened at a premium pays out when that
 * premium collapses, and every hour it stays open adds funding on top.
 *
 * Reconstructed from live state, never from memory:
 *
 * - **quantity** and **perp entry price** come from the exchange's own
 *   position record (`averageEntryPrice`), which is authoritative and
 *   survives a restart.
 * - **spot cost** comes from the execution journal, the one thing only this
 *   bot knows — the chain has the transfers but not which were ours.
 * - **exit prices** are real quotes for the real size, so spread and impact
 *   are charged rather than assumed away.
 *
 * Only pairs that pass {@link isManagedPair} are considered. The wallet holds
 * positions this bot did not open, and valuing those as if they were the
 * strategy's would be wrong in both directions.
 */

import type {ExecutionJournal} from '../journal/executionJournal.js';
import type {FundingRecorder} from '../journal/fundingRecorder.js';
import type {Logger} from '../logging/logger.js';
import type {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import {absDecimals, addDecimals, subtractDecimals} from '../perps/decimal.js';
import {isManagedPair} from '../perps/perpsShortService.js';
import type {PerpsShortService} from '../perps/perpsShortService.js';
import type {PerpPosition} from '../perps/types.js';
import {
  evaluateClose,
  formatOpportunity,
  OPPORTUNITY_HEADER,
  type CloseOpportunity,
} from './closeOpportunity.js';

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Consecutive whole-pass failures before the monitor gives up. Generous,
 * because the usual cause is a venue being briefly unavailable.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

/** One configured symbol the monitor knows how to value. */
export interface WatchedPair {
  readonly symbol: string;
  readonly market: string;
  /** Spot token balance in base units, read fresh each pass. */
  readSpotBalance(): Promise<string>;
  /** USDG a real quote says the whole spot leg would fetch now. */
  quoteSpotExit(quantity: string): Promise<string>;
  /** Price a taker would pay to buy the perp back — the conservative side. */
  quotePerpExit(): Promise<string>;
}

export interface PairMonitorOptions {
  readonly pairs: readonly WatchedPair[];
  readonly shorts: Pick<PerpsShortService, 'positions'>;
  readonly marketData: Pick<ArcusPerpsClient, 'getBbo'>;
  readonly journal: ExecutionJournal;
  readonly logger: Logger;
  /** Close when realizable PnL clears this. Negative expresses a stop. */
  readonly minProfitBps: number;
  /** Spot/perp size mismatch tolerated before a pair is treated as ours. */
  readonly deltaToleranceBps: number;
  readonly checkIntervalSeconds: number;
  /**
   * Mirrors newly settled funding into the journal on each pass.
   *
   * Without this the durable record only advances when something else
   * happens to sync it, and the carry — the whole point of the strategy —
   * quietly falls behind what the exchange has actually paid.
   */
  readonly funding?: Pick<FundingRecorder, 'sync'>;
  readonly sleep?: Sleep;
}

/** A pair that could not be valued this pass. Transient, usually. */
export interface PairValuationFailure {
  readonly market: string;
  readonly error: string;
}

export interface MonitorPass {
  readonly opportunities: readonly CloseOpportunity[];
  /** Positions skipped because they are not this strategy's. */
  readonly foreign: readonly string[];
  /** Pairs whose valuation failed — the position is still open regardless. */
  readonly failed: readonly PairValuationFailure[];
}

/**
 * Net USDG the journal says was spent acquiring a symbol's spot leg:
 * buys minus what earlier sells returned.
 */
export function spotCostFromJournal(
  journal: ExecutionJournal,
  symbol: string,
): string {
  let cost = '0';
  for (const event of journal.read()) {
    if (event.kind !== 'spot-fill' || event.symbol !== symbol) continue;
    // `sellAmount` on a buy is USDG out; `buyAmount` on a sell is USDG in.
    cost =
      event.direction === 'buy'
        ? addDecimals(cost, event.sellAmount)
        : subtractDecimals(cost, event.buyAmount);
  }
  return cost;
}

export class PairMonitor {
  private readonly options: PairMonitorOptions;
  private readonly sleep: Sleep;

  constructor(options: PairMonitorOptions) {
    this.options = options;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** One valuation pass over every watched pair. */
  async check(): Promise<MonitorPass> {
    const positions = await this.options.shorts.positions();
    const byMarket = new Map<string, PerpPosition>(
      positions.map(position => [position.marketDisplayName, position]),
    );

    const opportunities: CloseOpportunity[] = [];
    const foreign: string[] = [];
    const failed: PairValuationFailure[] = [];
    /** Market -> symbol, for markets this pass confirmed as ours. */
    const managed = new Map<string, string>();

    for (const pair of this.options.pairs) {
      const position = byMarket.get(pair.market);
      if (position === undefined) continue;

      const spotBalance = await pair.readSpotBalance();
      if (
        !isManagedPair(position, spotBalance, this.options.deltaToleranceBps)
      ) {
        foreign.push(pair.market);
        this.options.logger.debug(
          {
            market: pair.market,
            side: position.side,
            size: position.size,
            spotBalance,
          },
          'skipping a position this strategy does not own',
        );
        continue;
      }

      // Ownership is settled before any quote, so a failed valuation below
      // still counts as ours for the funding sync.
      managed.set(pair.market, pair.symbol);
      const quantity = absDecimals(position.size);
      const spotCostUsdg = spotCostFromJournal(
        this.options.journal,
        pair.symbol,
      );

      let spotExitProceeds: string;
      let perpExitPrice: string;
      try {
        [spotExitProceeds, perpExitPrice] = await Promise.all([
          pair.quoteSpotExit(quantity),
          pair.quotePerpExit(),
        ]);
      } catch (error) {
        // A quote is a live call to a venue that can be down — the Arcus
        // router returns "upstream venue unavailable" often enough to matter.
        // One unvaluable pair must not end a watch that is guarding real
        // open positions.
        const message = error instanceof Error ? error.message : String(error);
        failed.push({market: pair.market, error: message});
        this.options.logger.error(
          {market: pair.market, error: message},
          'could not value this pair; the position is unchanged',
        );
        continue;
      }

      const opportunity = evaluateClose(
        {
          symbol: pair.symbol,
          quantity,
          perpEntryPrice: position.averageEntryPrice,
          spotCostUsdg,
        },
        {
          spotExitProceeds,
          perpExitPrice,
          fundingEarned:
            position.cumulativeFunding.sinceOpen ??
            position.cumulativeFunding.allTime ??
            '0',
        },
        this.options.minProfitBps,
      );

      opportunities.push(opportunity);
      this.options.logger.info(
        {...opportunity},
        opportunity.worthClosing
          ? 'pair is worth closing'
          : 'pair checked, holding',
      );
    }

    await this.syncFunding(managed);
    return {opportunities, foreign, failed};
  }

  /**
   * Records funding paid since the last pass, for the pairs this strategy
   * actually owns.
   *
   * Scoped to `managed` rather than to everything being watched, and run
   * *after* ownership is decided — the candidate list contains any short on
   * the account, including the operator's own, and crediting their funding to
   * this strategy would overstate the carry by orders of magnitude.
   *
   * A sync failure is logged and swallowed: the journal falling behind must
   * not stop the monitor from valuing positions.
   */
  private async syncFunding(
    managed: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (this.options.funding === undefined || managed.size === 0) return;
    const bySymbol = managed;
    try {
      await this.options.funding.sync(market => bySymbol.get(market));
    } catch (error) {
      this.options.logger.warn(
        {error: error instanceof Error ? error.message : String(error)},
        'funding sync failed; valuation continues',
      );
    }
  }

  /**
   * Checks on an interval until stopped, printing a table each pass.
   *
   * Read-only: it reports and logs, and never closes anything on its own.
   * Unwinding is a fund-moving action and stays behind an explicit command.
   *
   * A pass that throws outright — the positions read failing, say — is logged
   * and the loop continues. This guards real open positions for hours at a
   * time against venues that go down for a minute; exiting would leave them
   * unwatched, which is strictly worse than a noisy log. Only a sustained run
   * of failures stops it, since at that point the monitor is not monitoring
   * anything and saying so loudly is more useful than looping in silence.
   */
  async run(options: {maxPasses?: number; print: (line: string) => void}) {
    let pass = 0;
    let consecutiveFailures = 0;

    while (options.maxPasses === undefined || pass < options.maxPasses) {
      pass++;
      const heading =
        `[${new Date().toISOString().slice(11, 19)}] pass ${pass} — ` +
        `close threshold ${this.options.minProfitBps} bps`;

      let result: MonitorPass;
      try {
        result = await this.check();
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures++;
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.error(
          {error: message, pass, consecutiveFailures},
          'monitor pass failed',
        );
        options.print('');
        options.print(heading);
        options.print(`  pass failed: ${message}`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          options.print(
            `  ${consecutiveFailures} passes in a row have failed — stopping. ` +
              'Open positions are untouched.',
          );
          return;
        }
        if (options.maxPasses !== undefined && pass >= options.maxPasses) break;
        await this.sleep(this.options.checkIntervalSeconds * 1000);
        continue;
      }

      const {opportunities, foreign, failed} = result;
      options.print('');
      options.print(heading);
      if (opportunities.length === 0 && failed.length === 0) {
        options.print('  no managed pairs open');
      } else if (opportunities.length > 0) {
        options.print(OPPORTUNITY_HEADER);
        for (const opportunity of opportunities) {
          options.print(formatOpportunity(opportunity));
        }
      }
      for (const failure of failed) {
        options.print(
          `  ${failure.market} could not be valued: ${failure.error}`,
        );
      }
      if (foreign.length > 0) {
        options.print(`  (ignoring foreign positions: ${foreign.join(', ')})`);
      }

      const ready = opportunities.filter(o => o.worthClosing);
      if (ready.length > 0) {
        options.print('');
        options.print(
          `  ${ready.map(o => o.symbol).join(', ')} above threshold — ` +
            'run `npm run close` to realize.',
        );
      }

      if (options.maxPasses !== undefined && pass >= options.maxPasses) break;
      await this.sleep(this.options.checkIntervalSeconds * 1000);
    }
  }
}
