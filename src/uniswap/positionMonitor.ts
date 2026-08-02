/**
 * Watches open positions across every configured symbol and closes each once
 * its pool has shifted fully to one side of its range.
 *
 * `token0` is USDG and `token1` is the stock token, so by Uniswap's own
 * convention a tick at or below `tickLower` means the position is entirely
 * USDG, and at or above `tickUpper` entirely stock. Either way the position has
 * stopped earning a two-sided spread, so it is closed, fees are collected with
 * the principal, and any stock token is sold back to USDG on Arcus.
 *
 * A close is only triggered after several consecutive out-of-range readings, so
 * a single-block wick that mean-reverts cannot realize a loss.
 *
 * One process watches every symbol's pool: there is no per-symbol scheduler.
 * The loop ticks at the cadence of the *fastest* configured
 * `checkIntervalSeconds` and checks every symbol's pool on every tick — a
 * symbol configured with a slower interval is simply checked more often than
 * it asked for, which costs an extra RPC read, not extra risk. Each position
 * still uses its own symbol's `exitConfirmations` threshold regardless of tick
 * cadence, since the breach counter is keyed per tokenId.
 */

import {randomUUID} from 'node:crypto';
import type {Hex} from 'viem';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Logger} from '../logging/logger.js';
import type {PoolIdentity} from './poolAddress.js';
import type {PoolReader, PoolState} from './poolReader.js';
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

/**
 * Tracks consecutive out-of-range readings per position.
 *
 * The threshold is supplied per call, not fixed at construction, since
 * different positions (from different symbols) can have different
 * `exitConfirmations`.
 */
export class BreachCounter {
  private readonly counts = new Map<string, number>();

  /** Records one observation; true once `threshold` is reached. */
  record(tokenId: bigint, status: RangeStatus, threshold: number): boolean {
    const key = tokenId.toString();
    if (status === 'in-range') {
      this.counts.delete(key);
      return false;
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next >= threshold;
  }

  count(tokenId: bigint): number {
    return this.counts.get(tokenId.toString()) ?? 0;
  }

  forget(tokenId: bigint): void {
    this.counts.delete(tokenId.toString());
  }
}

export type Sleep = (ms: number) => Promise<void>;

/** One symbol's pool and the exit service scoped to it. */
export interface WatchedSymbol {
  readonly symbol: string;
  readonly pool: PoolIdentity;
  readonly exitService: PositionExitService;
  readonly checkIntervalSeconds: number;
  readonly exitConfirmations: number;
}

export interface PositionMonitorOptions {
  readonly wallet: WalletProvider;
  readonly poolReader: PoolReader;
  readonly positionReader: PositionReader;
  readonly watchedSymbols: readonly WatchedSymbol[];
  readonly logger: Logger;
  /** When true, detect and report but never send a transaction. */
  readonly dryRun: boolean;
  readonly sleep?: Sleep;
}

export interface MonitorRunOptions {
  /**
   * Watch only this position instead of discovering across every watched
   * symbol. Requires exactly one watched symbol, so there is no ambiguity
   * about which pool it belongs to — narrow with `--symbol` first.
   */
  readonly tokenId?: bigint;
  /** Stop after this many polls. Omitted means run until no positions remain. */
  readonly maxPolls?: number;
}

/** A position, plus the watched-symbol context (pool, exit service) it belongs to. */
interface TrackedPosition {
  readonly position: OwnedPosition;
  readonly watched: WatchedSymbol;
}

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

export class PositionMonitor {
  private readonly sleep: Sleep;
  private readonly breaches: BreachCounter;

  constructor(private readonly options: PositionMonitorOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.breaches = new BreachCounter();
  }

  async run(runOptions: MonitorRunOptions = {}): Promise<void> {
    const {logger, wallet, watchedSymbols} = this.options;
    const owner = wallet.getAccount().address;

    if (runOptions.tokenId !== undefined && watchedSymbols.length !== 1) {
      throw new Error(
        '--token-id requires exactly one watched symbol; narrow with --symbol first',
      );
    }

    let tracked = await this.loadPositions(runOptions.tokenId, owner);
    if (tracked.length === 0) {
      logger.warn(
        {symbols: watchedSymbols.map(w => w.symbol)},
        'no open positions across any configured symbol, nothing to watch',
      );
      return;
    }

    const intervalSeconds = Math.min(
      ...watchedSymbols.map(w => w.checkIntervalSeconds),
    );

    logger.info(
      {
        positions: tracked.map(t => ({
          symbol: t.watched.symbol,
          tokenId: t.position.tokenId.toString(),
          tickLower: t.position.tickLower,
          tickUpper: t.position.tickUpper,
        })),
        intervalSeconds,
        dryRun: this.options.dryRun,
      },
      'monitor started',
    );

    for (let poll = 0; tracked.length > 0; poll++) {
      if (runOptions.maxPolls !== undefined && poll >= runOptions.maxPolls) {
        logger.info({polls: poll}, 'poll limit reached, stopping');
        return;
      }
      if (poll > 0) {
        await this.sleep(intervalSeconds * 1000);
      }

      const states = await this.readDistinctPools(tracked);
      const remaining: TrackedPosition[] = [];

      for (const entry of tracked) {
        const {position, watched} = entry;
        const state = states.get(watched.pool.address)!;
        const status = classifyTick(state.tick, position);
        const triggered = this.breaches.record(
          position.tokenId,
          status,
          watched.exitConfirmations,
        );

        logger.info(
          {
            symbol: watched.symbol,
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
          remaining.push(entry);
          continue;
        }

        if (this.options.dryRun) {
          logger.warn(
            {
              symbol: watched.symbol,
              tokenId: position.tokenId.toString(),
              status,
            },
            'dry run: would close this position and sell the stock token',
          );
          remaining.push(entry);
          this.breaches.forget(position.tokenId);
          continue;
        }

        await this.exit(entry, state.sqrtPriceX96, status);
        this.breaches.forget(position.tokenId);
      }

      tracked = remaining;
    }

    logger.info('all positions closed, monitor finished');
  }

  /** Reads each distinct pool among `tracked` once, not once per position. */
  private async readDistinctPools(
    tracked: readonly TrackedPosition[],
  ): Promise<Map<Hex, PoolState>> {
    const pools = new Map<Hex, PoolIdentity>();
    for (const {watched} of tracked)
      pools.set(watched.pool.address, watched.pool);

    const entries = await Promise.all(
      [...pools.values()].map(
        async pool =>
          [
            pool.address,
            await this.options.poolReader.readState(pool),
          ] as const,
      ),
    );
    return new Map(entries);
  }

  private async loadPositions(
    tokenId: bigint | undefined,
    owner: Hex,
  ): Promise<TrackedPosition[]> {
    const {positionReader, watchedSymbols, logger} = this.options;

    if (tokenId === undefined) {
      const perSymbol = await Promise.all(
        watchedSymbols.map(async watched => ({
          watched,
          positions: await positionReader.discover(watched.pool, owner),
        })),
      );
      return perSymbol.flatMap(({watched, positions}) =>
        positions.map(position => ({position, watched})),
      );
    }

    const watched = watchedSymbols[0]!;
    const position = await positionReader.read(tokenId, watched.pool, owner);
    if (!position) {
      logger.error(
        {symbol: watched.symbol, tokenId: tokenId.toString()},
        'requested position is not an open position of this wallet in this pool',
      );
      return [];
    }
    return [{position, watched}];
  }

  /** Delegates to the shared exit service, so it matches the manual command. */
  private async exit(
    entry: TrackedPosition,
    sqrtPriceX96: bigint,
    status: RangeStatus,
  ): Promise<void> {
    const {position, watched} = entry;
    const tradeId = randomUUID();
    this.options.logger.info(
      {
        tradeId,
        symbol: watched.symbol,
        tokenId: position.tokenId.toString(),
        status,
      },
      'exit triggered',
    );

    const plan = await watched.exitService.plan(position, sqrtPriceX96);
    await watched.exitService.exit(plan, tradeId);
  }
}
