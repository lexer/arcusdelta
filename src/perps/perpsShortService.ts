/**
 * Opening, closing, and unwinding the perp leg of a delta-neutral pair.
 *
 * This is where the ownership guards live. The wallet carries perp positions
 * this bot did not open, positions net per market, and a perp position has no
 * id — so "is this ours?" has to be answered from observable state:
 *
 * - **Opening** refuses a market that already has *any* position. Shorting a
 *   symbol the operator is manually long would silently reduce their position
 *   instead of opening a hedge.
 * - **Managing** claims a market only when the position is SHORT *and* the
 *   wallet's spot balance matches the short size within tolerance — the
 *   structural signature of a pair this strategy created.
 *
 * No local ledger is involved, which is what keeps this correct when the
 * wallet is used outside the bot.
 */

import type {ExecutionJournal} from '../journal/executionJournal.js';
import type {Logger} from '../logging/logger.js';
import type {ArcusPerpsClient} from './arcusPerpsClient.js';
import type {AuthenticatedPerpsClient} from './authenticatedPerpsClient.js';
import {
  absDecimals,
  compareDecimals,
  divideDecimals,
  isPositive,
  multiplyDecimals,
  subtractDecimals,
} from './decimal.js';
import {PerpsMarginError, PerpsPositionConflictError} from './errors.js';
import {toEngineOrder} from './marketRegistry.js';
import type {
  MakerOrderExecutor,
  MakerOrderResult,
} from './makerOrderExecutor.js';
import type {MarketSpec, PerpPosition} from './types.js';

export interface PerpsShortServiceOptions {
  readonly client: Pick<AuthenticatedPerpsClient, 'placeOrder'>;
  readonly marketData: Pick<ArcusPerpsClient, 'getAccount' | 'getPositions'>;
  readonly executor: Pick<MakerOrderExecutor, 'fill'>;
  readonly journal: ExecutionJournal;
  readonly logger: Logger;
  readonly address: string;
  readonly accountIndex: number;
}

export interface OpenShortRequest {
  readonly tradeId: string;
  readonly symbol: string;
  readonly spec: MarketSpec;
  /** Human decimal, aligned to the market's step size. */
  readonly quantity: string;
  readonly repriceSeconds: number;
  readonly maxAttempts: number;
  /** Ticks to post in front of the touch. See {@link MakerOrderRequest}. */
  readonly improveTicks?: number;
}

export class PerpsShortService {
  private readonly client: PerpsShortServiceOptions['client'];
  private readonly marketData: PerpsShortServiceOptions['marketData'];
  private readonly executor: PerpsShortServiceOptions['executor'];
  private readonly journal: ExecutionJournal;
  private readonly logger: Logger;
  private readonly address: string;
  private readonly accountIndex: number;

  constructor(options: PerpsShortServiceOptions) {
    this.client = options.client;
    this.marketData = options.marketData;
    this.executor = options.executor;
    this.journal = options.journal;
    this.logger = options.logger;
    this.address = options.address;
    this.accountIndex = options.accountIndex;
  }

  /** Every open position on the account, bot-created or not. */
  async positions(): Promise<PerpPosition[]> {
    const raw = await this.marketData.getPositions(
      this.address,
      this.accountIndex,
    );
    // The gateway returns an object keyed by marketId on some routes and an
    // array on others; normalize so callers never have to care.
    return Array.isArray(raw) ? raw : Object.values(raw);
  }

  async positionFor(market: string): Promise<PerpPosition | undefined> {
    return (await this.positions()).find(
      position => position.marketDisplayName === market,
    );
  }

  /** `equity − Σ initial margin required`. What a new order may consume. */
  async freeCollateral(): Promise<string> {
    const account = await this.marketData.getAccount(
      this.address,
      this.accountIndex,
    );
    return account.freeCollateral;
  }

  /**
   * Refuses to proceed when a position already exists in this market.
   *
   * The guard that keeps the bot away from the operator's manual positions.
   * Netting means a short here would reduce a long rather than hedge anything,
   * and nothing downstream could tell the difference afterwards.
   */
  async assertNoExistingPosition(spec: MarketSpec): Promise<void> {
    const existing = await this.positionFor(spec.market);
    if (existing === undefined) return;

    this.logger.error(
      {
        market: spec.market,
        side: existing.side,
        size: existing.size,
      },
      'refusing to open: a position already exists in this market',
    );
    throw new PerpsPositionConflictError(
      `${spec.market} already has a ${existing.side} position of ${existing.size}. ` +
        'This bot will not trade a market it does not exclusively own — close it first.',
      spec.market,
      existing.side,
      existing.size,
    );
  }

  /**
   * Refuses to proceed unless free collateral covers the initial margin this
   * order would reserve, with the configured headroom.
   *
   * Off-hours the requirement rises (`offHoursInitialMarginFraction`), so the
   * stricter of the two is used — sizing against the regular-hours number and
   * then opening after the close would fail at the engine.
   */
  async assertSufficientCollateral(
    spec: MarketSpec,
    quantity: string,
    price: string,
    headroomMultiple: number,
  ): Promise<void> {
    const notional = multiplyDecimals(quantity, price);
    const fraction =
      compareDecimals(
        spec.offHoursInitialMarginFraction,
        spec.initialMarginFraction,
      ) > 0
        ? spec.offHoursInitialMarginFraction
        : spec.initialMarginFraction;
    const required = multiplyDecimals(
      multiplyDecimals(notional, fraction),
      String(headroomMultiple),
    );
    const available = await this.freeCollateral();

    if (compareDecimals(available, required) < 0) {
      this.logger.error(
        {market: spec.market, notional, required, available},
        'insufficient free collateral to open',
      );
      throw new PerpsMarginError(
        `${spec.market} needs ${required} USDG of free collateral ` +
          `(${notional} notional at ${fraction} initial margin, ` +
          `${headroomMultiple}x headroom) but only ${available} is available.`,
      );
    }

    this.logger.info(
      {market: spec.market, notional, required, available},
      'collateral checked',
    );
  }

  /** Opens (or adds to) a short as a maker. Never crosses. */
  async openShort(request: OpenShortRequest): Promise<MakerOrderResult> {
    return this.executor.fill({
      tradeId: request.tradeId,
      symbol: request.symbol,
      spec: request.spec,
      side: 'SELL',
      targetQuantity: request.quantity,
      repriceSeconds: request.repriceSeconds,
      maxAttempts: request.maxAttempts,
      ...(request.improveTicks === undefined
        ? {}
        : {improveTicks: request.improveTicks}),
    });
  }

  /** Buys back a short as a maker, reduce-only so it cannot flip to a long. */
  async closeShort(request: OpenShortRequest): Promise<MakerOrderResult> {
    return this.executor.fill({
      tradeId: request.tradeId,
      symbol: request.symbol,
      spec: request.spec,
      side: 'BUY',
      targetQuantity: request.quantity,
      reduceOnly: true,
      repriceSeconds: request.repriceSeconds,
      maxAttempts: request.maxAttempts,
      ...(request.improveTicks === undefined
        ? {}
        : {improveTicks: request.improveTicks}),
    });
  }

  /**
   * Buys back a short **immediately**, crossing the spread.
   *
   * The one place this strategy pays the taker fee, and it is the right
   * trade: this runs when a perp short filled but its spot hedge did not, so
   * the account is holding an unhedged leveraged short. 2.25 bps is cheap
   * against carrying that.
   *
   * `reduceOnly` is load-bearing, not politeness — it guarantees the buy-back
   * cannot overshoot into a long if the position moved underneath it.
   */
  async unwindShort(
    tradeId: string,
    symbol: string,
    spec: MarketSpec,
    quantity: string,
    markPrice: string,
    slippageBps: number,
  ): Promise<void> {
    // A protective bound, not a limit to rest at: IOC takes whatever is
    // available up to this price and cancels the rest.
    const bound = multiplyDecimals(markPrice, String(1 + slippageBps / 10_000));
    const amounts = toEngineOrder(
      spec,
      roundToTick(bound, spec.tickSize),
      quantity,
      {reduceOnly: true},
    );

    this.logger.warn(
      {market: spec.market, quantity, bound: amounts.price},
      'unwinding an unhedged perp short as a taker',
    );

    const order = await this.client.placeOrder({
      marketId: spec.marketId,
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'IOC',
      amounts,
      reduceOnly: true,
      clientId: `${tradeId}-unwind`.slice(0, 36),
    });

    this.journal.record({
      kind: 'perp-fill',
      at: new Date().toISOString(),
      tradeId,
      symbol,
      market: spec.market,
      marketId: spec.marketId,
      side: 'BUY',
      orderId: order.orderId,
      filledQuantity: order.filledSize ?? quantity,
      requestedQuantity: quantity,
      limitPrice: amounts.price,
      ...(order.averageFillPrice === undefined
        ? {}
        : {averageFillPrice: order.averageFillPrice}),
      timeInForce: 'IOC',
      reduceOnly: true,
      maker: false,
    });

    this.logger.warn(
      {market: spec.market, orderId: order.orderId, status: order.status},
      'unwind submitted',
    );
  }
}

/** Rounds up to the tick grid — an upper bound must not round downward. */
function roundToTick(value: string, tickSize: string): string {
  const ticks = divideDecimals(value, tickSize);
  const whole = ticks.split('.')[0] ?? '0';
  const hasRemainder =
    ticks.includes('.') && isPositive(`0.${ticks.split('.')[1]}`);
  const rounded = hasRemainder ? addOne(whole) : whole;
  return multiplyDecimals(rounded, tickSize);
}

function addOne(whole: string): string {
  return (BigInt(whole) + 1n).toString();
}

/** Signed size of a position: negative for a short. */
export function signedSize(position: PerpPosition): string {
  return position.side === 'SHORT'
    ? `-${absDecimals(position.size)}`
    : absDecimals(position.size);
}

/**
 * Whether a market's position looks like one this strategy created: a short
 * whose size the wallet's spot balance matches within `toleranceBps`.
 *
 * The operator's own SPCX short fails this decisively — 265 short against a
 * 0.0072 spot balance — which is exactly the separation this provides.
 */
export function isManagedPair(
  position: PerpPosition,
  spotBalance: string,
  toleranceBps: number,
): boolean {
  if (position.side !== 'SHORT') return false;

  const shortSize = absDecimals(position.size);
  if (!isPositive(shortSize)) return false;

  const difference = absDecimals(subtractDecimals(spotBalance, shortSize));
  const driftBps = multiplyDecimals(
    divideDecimals(difference, shortSize),
    '10000',
  );
  return compareDecimals(driftBps, String(toleranceBps)) <= 0;
}
