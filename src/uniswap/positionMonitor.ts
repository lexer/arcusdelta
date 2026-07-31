/**
 * Watches open positions and closes them once the pool has shifted fully to
 * one side of their range.
 *
 * `currency0` is USDG and `currency1` is the stock token, so by Uniswap's own
 * convention a tick at or below `tickLower` means the position is entirely
 * USDG, and at or above `tickUpper` entirely stock. Either way the position has
 * stopped earning a two-sided spread, so it is closed, fees are collected with
 * the principal, and any stock token is sold back to USDG on Arcus.
 *
 * A close is only triggered after several consecutive out-of-range readings, so
 * a single-block wick that mean-reverts cannot realize a loss.
 */

import {randomUUID} from 'node:crypto';
import type {Hex} from 'viem';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Logger} from '../logging/logger.js';
import type {PoolKey} from './poolKey.js';
import type {PoolReader} from './poolReader.js';
import type {PositionExitService} from './positionExitService.js';
import type {OwnedPosition, PositionReader} from './positionReader.js';

export type RangeStatus = 'in-range' | 'below-range' | 'above-range';

/**
 * Where the pool sits relative to a position.
 *
 * Boundaries count as out of range: at exactly `tickLower` the position holds
 * no stock token, and at `tickUpper` no USDG.
 */
export function classifyTick(
  tick: number,
  position: Pick<OwnedPosition, 'tickLower' | 'tickUpper'>,
): RangeStatus {
  if (tick <= position.tickLower) return 'below-range';
  if (tick >= position.tickUpper) return 'above-range';
  return 'in-range';
}

/** Tracks consecutive out-of-range readings per position. */
export class BreachCounter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly threshold: number) {}

  /** Records one observation; true once the threshold is reached. */
  record(tokenId: bigint, status: RangeStatus): boolean {
    const key = tokenId.toString();
    if (status === 'in-range') {
      this.counts.delete(key);
      return false;
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next >= this.threshold;
  }

  count(tokenId: bigint): number {
    return this.counts.get(tokenId.toString()) ?? 0;
  }

  forget(tokenId: bigint): void {
    this.counts.delete(tokenId.toString());
  }
}

export type Sleep = (ms: number) => Promise<void>;

export interface PositionMonitorOptions {
  readonly wallet: WalletProvider;
  readonly poolReader: PoolReader;
  readonly positionReader: PositionReader;
  readonly exitService: PositionExitService;
  readonly logger: Logger;
  readonly poolKey: PoolKey;
  readonly checkIntervalSeconds: number;
  readonly exitConfirmations: number;
  /** When true, detect and report but never send a transaction. */
  readonly dryRun: boolean;
  readonly sleep?: Sleep;
}

export interface MonitorRunOptions {
  /** Watch only this position instead of discovering them. */
  readonly tokenId?: bigint;
  /** Stop after this many polls. Omitted means run until no positions remain. */
  readonly maxPolls?: number;
}

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

export class PositionMonitor {
  private readonly sleep: Sleep;
  private readonly breaches: BreachCounter;

  constructor(private readonly options: PositionMonitorOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.breaches = new BreachCounter(options.exitConfirmations);
  }

  async run(runOptions: MonitorRunOptions = {}): Promise<void> {
    const {logger, poolKey, wallet} = this.options;
    const owner = wallet.getAccount().address;

    let positions = await this.loadPositions(runOptions.tokenId, owner);
    if (positions.length === 0) {
      logger.warn('no open positions in the configured pool, nothing to watch');
      return;
    }

    logger.info(
      {
        positions: positions.map(p => ({
          tokenId: p.tokenId.toString(),
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
        })),
        intervalSeconds: this.options.checkIntervalSeconds,
        exitConfirmations: this.options.exitConfirmations,
        dryRun: this.options.dryRun,
      },
      'monitor started',
    );

    for (let poll = 0; positions.length > 0; poll++) {
      if (runOptions.maxPolls !== undefined && poll >= runOptions.maxPolls) {
        logger.info({polls: poll}, 'poll limit reached, stopping');
        return;
      }
      if (poll > 0) {
        await this.sleep(this.options.checkIntervalSeconds * 1000);
      }

      const state = await this.options.poolReader.readState(poolKey);
      const remaining: OwnedPosition[] = [];

      for (const position of positions) {
        const status = classifyTick(state.tick, position);
        const triggered = this.breaches.record(position.tokenId, status);

        logger.info(
          {
            tokenId: position.tokenId.toString(),
            tick: state.tick,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            status,
            consecutiveBreaches: this.breaches.count(position.tokenId),
            triggered,
          },
          'polled position',
        );

        if (!triggered) {
          remaining.push(position);
          continue;
        }

        if (this.options.dryRun) {
          logger.warn(
            {tokenId: position.tokenId.toString(), status},
            'dry run: would close this position and sell the stock token',
          );
          remaining.push(position);
          this.breaches.forget(position.tokenId);
          continue;
        }

        await this.exit(position, state.sqrtPriceX96, status);
        this.breaches.forget(position.tokenId);
      }

      positions = remaining;
    }

    logger.info('all positions closed, monitor finished');
  }

  private async loadPositions(
    tokenId: bigint | undefined,
    owner: Hex,
  ): Promise<OwnedPosition[]> {
    const {positionReader, poolKey, logger} = this.options;

    if (tokenId === undefined) {
      return positionReader.discover(poolKey, owner);
    }

    const position = await positionReader.read(tokenId, poolKey, owner);
    if (!position) {
      logger.error(
        {tokenId: tokenId.toString()},
        'requested position is not an open position of this wallet in this pool',
      );
      return [];
    }
    return [position];
  }

  /** Delegates to the shared exit service, so it matches the manual command. */
  private async exit(
    position: OwnedPosition,
    sqrtPriceX96: bigint,
    status: RangeStatus,
  ): Promise<void> {
    const tradeId = randomUUID();
    this.options.logger.info(
      {tradeId, tokenId: position.tokenId.toString(), status},
      'exit triggered',
    );

    const plan = await this.options.exitService.plan(position, sqrtPriceX96);
    await this.options.exitService.exit(plan, tradeId);
  }
}
