/**
 * The authenticated half of the Arcus perps gateway: placing, cancelling, and
 * reading back orders.
 *
 * Split from {@link ArcusPerpsClient} so the read path stays usable with no
 * key at all — `npm run funding` must never need a credential — while
 * everything that can move a position lives behind one class that owns the
 * signer.
 *
 * Two properties this file exists to guarantee:
 *
 * - **The signed payload and the HTTP body always describe the same order.**
 *   They are derived from one {@link EngineOrderAmounts}, and the nanosecond
 *   timestamp is the same `bigint` in both.
 * - **`cancelAllOrders` is deliberately absent.** It cancels every open order
 *   for `(address, accountIndex)`, and this wallet has other API keys placing
 *   orders of their own. Cancellation is by order id, always.
 */

import type {Logger} from '../logging/logger.js';
import {ArcusPerpsClient} from './arcusPerpsClient.js';
import type {ArcusPerpsClientOptions} from './arcusPerpsClient.js';
import {PerpsOrderRejectedError} from './errors.js';
import type {EngineOrderAmounts} from './marketRegistry.js';
import {
  buildCancelOrderPayload,
  buildPlaceOrderPayload,
  nowNanos,
  OrderSide,
  PerpsRequestSigner,
  TimeInForce,
} from './signing.js';
import type {OrderSideCode, TimeInForceCode} from './signing.js';
import type {
  OrderResponse,
  OrderSideName,
  OrderTypeName,
  TimeInForceName,
} from './types.js';

const MICROS_PER_MS = 1_000;
const NANOS_PER_MICRO = 1_000n;
const MS_PER_DAY = 86_400_000;

/**
 * `goodTilTime` must be at least a month ahead or the gateway rejects the
 * order. 45 days keeps a comfortable margin against clock skew, and the value
 * is irrelevant in practice: post-only chunks are cancelled explicitly on
 * timeout, and IOC orders never rest.
 */
const GOOD_TIL_DAYS = 45;

const SIDE_CODES: Readonly<Record<OrderSideName, OrderSideCode>> = {
  BUY: OrderSide.BUY,
  SELL: OrderSide.SELL,
};

const TIF_CODES: Readonly<Record<TimeInForceName, TimeInForceCode>> = {
  GTT: TimeInForce.GTT,
  IOC: TimeInForce.IOC,
  FOK: TimeInForce.FOK,
  ALO: TimeInForce.ALO,
};

export interface PlaceOrderOptions {
  readonly marketId: number;
  readonly side: OrderSideName;
  readonly orderType: OrderTypeName;
  readonly timeInForce: TimeInForceName;
  readonly amounts: EngineOrderAmounts;
  readonly reduceOnly?: boolean;
  readonly clientId?: string;
}

export interface AuthenticatedPerpsClientOptions
  extends ArcusPerpsClientOptions {
  readonly signer: PerpsRequestSigner;
  /** Master Ethereum address the API key is registered against. */
  readonly address: string;
  readonly accountIndex: number;
  /** Injected so tests are not tied to the wall clock. */
  readonly now?: () => number;
}

export class AuthenticatedPerpsClient extends ArcusPerpsClient {
  private readonly signer: PerpsRequestSigner;
  private readonly address: string;
  private readonly accountIndex: number;
  private readonly clock: () => number;
  private readonly authLogger: Logger;

  constructor(options: AuthenticatedPerpsClientOptions) {
    super(options);
    this.signer = options.signer;
    this.address = options.address;
    this.accountIndex = options.accountIndex;
    this.clock = options.now ?? (() => Date.now());
    this.authLogger = options.logger;
  }

  /**
   * Places one order.
   *
   * A `202` means the gateway accepted it and forwarded it to the engine —
   * `status` is `ACK` and says nothing about whether it rested or filled. Only
   * a subsequent {@link getOrder} settles that.
   */
  async placeOrder(options: PlaceOrderOptions): Promise<OrderResponse> {
    const timestampNs = nowNanos(this.clock());
    const goodTilTimeMicros = BigInt(
      (this.clock() + GOOD_TIL_DAYS * MS_PER_DAY) * MICROS_PER_MS,
    );
    const reduceOnly = options.reduceOnly === true;

    const payload = buildPlaceOrderPayload({
      address: this.address,
      accountIndex: this.accountIndex,
      ...(options.clientId === undefined ? {} : {clientId: options.clientId}),
      clientTimestampNs: timestampNs,
      goodTilTimeNs: goodTilTimeMicros * NANOS_PER_MICRO,
      marketId: options.marketId,
      priceTicks: options.amounts.priceTicks,
      quantityQuantums: options.amounts.quantityQuantums,
      reduceOnly,
      side: SIDE_CODES[options.side],
      timeInForce: TIF_CODES[options.timeInForce],
    });

    this.authLogger.info(
      {
        marketId: options.marketId,
        side: options.side,
        orderType: options.orderType,
        timeInForce: options.timeInForce,
        price: options.amounts.price,
        quantity: options.amounts.quantity,
        reduceOnly,
        clientId: options.clientId,
      },
      'placing perp order',
    );

    const response = await this.post<OrderResponse>(
      '/v1/placeOrder',
      {
        address: this.address,
        accountIndex: this.accountIndex,
        marketId: options.marketId,
        orderSide: options.side,
        orderType: options.orderType,
        quantity: options.amounts.quantity,
        price: options.amounts.price,
        timeInForce: options.timeInForce,
        goodTilTime: goodTilTimeMicros.toString(),
        reduceOnly,
        ...(options.clientId === undefined ? {} : {clientId: options.clientId}),
        timestamp: timestampNs,
      },
      this.signer.authForPayload(payload, timestampNs),
    );

    if (response.status === 'REJECTED' || response.status === 'ERROR') {
      const reason = response.rejectionReason ?? response.status;
      this.authLogger.error(
        {marketId: options.marketId, orderId: response.orderId, reason},
        'perp order rejected',
      );
      throw new PerpsOrderRejectedError(
        `Order on market ${options.marketId} was rejected: ${reason}`,
        reason,
      );
    }

    this.authLogger.info(
      {
        marketId: options.marketId,
        orderId: response.orderId,
        status: response.status,
      },
      'perp order accepted',
    );
    return response;
  }

  /** Cancels one order by its server id. Never cancels anything else. */
  async cancelOrder(marketId: number, orderId: string): Promise<void> {
    const timestampNs = nowNanos(this.clock());
    const payload = buildCancelOrderPayload({
      address: this.address,
      accountIndex: this.accountIndex,
      clientTimestampNs: timestampNs,
      marketId,
      orderId,
    });

    this.authLogger.info({marketId, orderId}, 'cancelling perp order');
    await this.post(
      '/v1/cancelOrder',
      {
        address: this.address,
        accountIndex: this.accountIndex,
        marketId,
        orderId,
        timestamp: timestampNs,
      },
      this.signer.authForPayload(payload, timestampNs),
    );
    this.authLogger.info({marketId, orderId}, 'perp order cancel submitted');
  }

  /** Current state of one order. Unauthenticated, but scoped to this account. */
  async getOrder(orderId: string): Promise<OrderResponse> {
    return this.getJson<OrderResponse>(
      `/v1/order/${encodeURIComponent(orderId)}`,
      {address: this.address, accountIndex: this.accountIndex},
    );
  }

  /**
   * Every open order on this account — **including orders placed by other API
   * keys registered to the same wallet**. Callers must filter rather than
   * assume ownership.
   */
  async getOpenOrders(): Promise<OrderResponse[]> {
    const body = await this.getJson<{orders: OrderResponse[]}>(
      '/v1/openOrders',
      {address: this.address, accountIndex: this.accountIndex},
    );
    return body.orders ?? [];
  }
}
