/**
 * Fills a target quantity as a **maker**: post at the touch, wait, re-price if
 * the market walked away, and never cross.
 *
 * The base fee tier is `maker 0 ppm / taker 225 ppm`, and NVDA's spread is
 * ~4.5 bps, so posting rather than crossing saves the fee *and* half the
 * spread on every fill. Against a single-digit APR carry that difference is
 * most of the edge, which is why entries are post-only and a chunk that will
 * not fill aborts rather than paying up.
 *
 * `ALO` is what makes this safe: if the book moved between reading the BBO and
 * the order landing, the engine rejects with `POST_ONLY_WOULD_CROSS` instead of
 * filling as a taker. A rejection is a retry, not a loss — verified live.
 *
 * Cancellation is always **by order id**. `cancelAllOrders` would also kill
 * orders placed by the other API keys registered to this wallet.
 */

import type {ExecutionJournal} from '../journal/executionJournal.js';
import type {Logger} from '../logging/logger.js';
import type {ArcusPerpsClient} from './arcusPerpsClient.js';
import type {AuthenticatedPerpsClient} from './authenticatedPerpsClient.js';
import {
  addDecimals,
  compareDecimals,
  isPositive,
  subtractDecimals,
  weightedAverage,
} from './decimal.js';
import {PerpsOrderRejectedError, PerpsOrderSizeError} from './errors.js';
import {toEngineOrder} from './marketRegistry.js';
import type {MarketSpec, OrderResponse, OrderSideName} from './types.js';
import {TERMINAL_ORDER_STATUSES} from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface MakerOrderRequest {
  readonly tradeId: string;
  readonly symbol: string;
  readonly spec: MarketSpec;
  readonly side: OrderSideName;
  /** Human decimal, already aligned to the market's step size. */
  readonly targetQuantity: string;
  readonly reduceOnly?: boolean;
  /** How long one resting attempt is given before it is re-priced. */
  readonly repriceSeconds: number;
  /** Placements to try before giving up with whatever filled. */
  readonly maxAttempts: number;
  readonly pollIntervalMs?: number;
}

export interface MakerOrderResult {
  readonly filledQuantity: string;
  /** Size-weighted mean fill price, or undefined when nothing filled. */
  readonly averageFillPrice: string | undefined;
  /** Placements actually made — a post-only rejection counts as one. */
  readonly attempts: number;
  readonly orderIds: readonly string[];
  /** True when the full target was filled. */
  readonly complete: boolean;
}

export interface MakerOrderExecutorOptions {
  readonly client: Pick<
    AuthenticatedPerpsClient,
    'placeOrder' | 'cancelOrder' | 'getOrder'
  >;
  readonly marketData: Pick<ArcusPerpsClient, 'getBbo'>;
  readonly journal: ExecutionJournal;
  readonly logger: Logger;
  readonly sleep?: Sleep;
}

/** Filled size on an order response, defaulting to none. */
function filledOf(order: OrderResponse): string {
  return order.filledSize ?? '0';
}

export class MakerOrderExecutor {
  private readonly client: MakerOrderExecutorOptions['client'];
  private readonly marketData: MakerOrderExecutorOptions['marketData'];
  private readonly journal: ExecutionJournal;
  private readonly logger: Logger;
  private readonly sleep: Sleep;

  constructor(options: MakerOrderExecutorOptions) {
    this.client = options.client;
    this.marketData = options.marketData;
    this.journal = options.journal;
    this.logger = options.logger;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Works the target down across up to `maxAttempts` postings.
   *
   * Returns whatever filled rather than throwing on a shortfall — a partial
   * fill is a real position that the caller has to hedge or unwind, and
   * throwing would hide it.
   */
  async fill(request: MakerOrderRequest): Promise<MakerOrderResult> {
    const log = this.logger.child({
      tradeId: request.tradeId,
      symbol: request.symbol,
      market: request.spec.market,
      side: request.side,
    });
    log.info(
      {
        targetQuantity: request.targetQuantity,
        maxAttempts: request.maxAttempts,
        repriceSeconds: request.repriceSeconds,
        reduceOnly: request.reduceOnly === true,
      },
      'maker fill started',
    );

    const fills: Array<readonly [string, string]> = [];
    const orderIds: string[] = [];
    let remaining = request.targetQuantity;
    let attempts = 0;

    while (attempts < request.maxAttempts && isPositive(remaining)) {
      attempts++;
      const attemptLog = log.child({attempt: attempts});

      const price = await this.touchPrice(request, attemptLog);
      if (price === undefined) break;

      const amounts = this.sizeAttempt(request, price, remaining, attemptLog);
      if (amounts === undefined) break;

      let placed: OrderResponse;
      try {
        placed = await this.client.placeOrder({
          marketId: request.spec.marketId,
          side: request.side,
          orderType: 'LIMIT',
          timeInForce: 'ALO',
          amounts,
          ...(request.reduceOnly === undefined
            ? {}
            : {reduceOnly: request.reduceOnly}),
          clientId: `${request.tradeId}-${attempts}`.slice(0, 36),
        });
      } catch (error) {
        if (
          error instanceof PerpsOrderRejectedError &&
          isPostOnlyCross(error.reason)
        ) {
          // The book moved between reading the BBO and the order landing.
          // Exactly what post-only is for: re-read and try again.
          attemptLog.info(
            {reason: error.reason},
            'post-only would have crossed; re-pricing',
          );
          continue;
        }
        throw error;
      }

      orderIds.push(placed.orderId);
      const settled = await this.restThenCancel(placed, request, attemptLog);

      const filled = filledOf(settled);
      if (isPositive(filled)) {
        fills.push([filled, price]);
        remaining = subtractDecimals(remaining, filled);
        this.recordFill(request, settled, price, filled, attempts);
        attemptLog.info({filled, remaining, price}, 'maker attempt filled');
      } else {
        attemptLog.info({price}, 'maker attempt filled nothing');
      }
    }

    const filledQuantity = fills.reduce(
      (sum, [quantity]) => addDecimals(sum, quantity),
      '0',
    );
    const result: MakerOrderResult = {
      filledQuantity,
      averageFillPrice: weightedAverage(fills),
      attempts,
      orderIds,
      complete: compareDecimals(filledQuantity, request.targetQuantity) >= 0,
    };

    log.info({...result}, 'maker fill finished');
    return result;
  }

  /**
   * The price to post at: the best ask for a sell, the best bid for a buy.
   *
   * Joining the touch rather than improving it — improving would cost a tick
   * for queue priority the strategy does not need, and posting *through* it
   * would cross.
   */
  private async touchPrice(
    request: MakerOrderRequest,
    log: Logger,
  ): Promise<string | undefined> {
    const bbo = await this.marketData.getBbo(request.spec.market);
    const level = request.side === 'SELL' ? bbo.bestAsk : bbo.bestBid;
    if (level === null) {
      log.warn(
        {side: request.side},
        'no resting liquidity on the side to join; cannot post',
      );
      return undefined;
    }
    return level.price;
  }

  /**
   * Validates this attempt's remaining size against the market's rules.
   *
   * A remainder can fall below `minOrderSize` or the minimum notional as the
   * fill works down — that is a normal stopping condition, not an error.
   */
  private sizeAttempt(
    request: MakerOrderRequest,
    price: string,
    remaining: string,
    log: Logger,
  ) {
    try {
      return toEngineOrder(request.spec, price, remaining, {
        ...(request.reduceOnly === undefined
          ? {}
          : {reduceOnly: request.reduceOnly}),
      });
    } catch (error) {
      if (error instanceof PerpsOrderSizeError) {
        log.info(
          {remaining, price, reason: error.message},
          'remaining size is no longer placeable; stopping',
        );
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Lets an order rest for `repriceSeconds`, then cancels whatever is left.
   *
   * The state is always re-read *after* the cancel: a fill can land between
   * the last poll and the cancel arriving, and treating that as unfilled would
   * lose track of a real position.
   */
  private async restThenCancel(
    placed: OrderResponse,
    request: MakerOrderRequest,
    log: Logger,
  ): Promise<OrderResponse> {
    const pollIntervalMs = request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = request.repriceSeconds * 1000;
    let waited = 0;
    let latest = placed;

    while (waited < deadline) {
      await this.sleep(pollIntervalMs);
      waited += pollIntervalMs;

      latest = await this.client.getOrder(placed.orderId);
      if (TERMINAL_ORDER_STATUSES.has(latest.status)) {
        log.info({status: latest.status}, 'order reached a terminal state');
        return latest;
      }
    }

    await this.client.cancelOrder(request.spec.marketId, placed.orderId);
    // Re-read rather than assuming the cancel beat the market.
    const afterCancel = await this.client.getOrder(placed.orderId);
    log.info(
      {status: afterCancel.status, filledSize: filledOf(afterCancel)},
      'order cancelled after reprice window',
    );
    return afterCancel;
  }

  private recordFill(
    request: MakerOrderRequest,
    order: OrderResponse,
    limitPrice: string,
    filled: string,
    attempts: number,
  ): void {
    this.journal.record({
      kind: 'perp-fill',
      at: new Date().toISOString(),
      tradeId: request.tradeId,
      symbol: request.symbol,
      market: request.spec.market,
      marketId: request.spec.marketId,
      side: request.side,
      orderId: order.orderId,
      ...(order.clientId === undefined ? {} : {clientId: order.clientId}),
      filledQuantity: filled,
      requestedQuantity: request.targetQuantity,
      limitPrice,
      // A resting order fills at its own limit price, so the limit is the
      // fill price unless the gateway says otherwise.
      averageFillPrice: order.averageFillPrice ?? limitPrice,
      timeInForce: 'ALO',
      reduceOnly: request.reduceOnly === true,
      maker: true,
      attempts,
    });
  }
}

/** The engine's way of saying "your post-only order would have taken". */
function isPostOnlyCross(reason: string): boolean {
  return reason.toUpperCase().includes('POST_ONLY');
}
