/**
 * Wire types for the Arcus perpetuals REST API.
 *
 * Every numeric quantity the exchange returns is a *decimal string*, not a
 * number — prices, sizes, margins, funding rates alike. They are kept as
 * strings all the way through this layer: converting to `number` loses
 * precision, and the order path needs exact integer ticks and quantums
 * derived from these values (see `marketRegistry.ts`).
 */

/** One perp market as `GET /v1/markets` returns it. */
export interface PerpMarket {
  readonly marketDisplayName: string;
  readonly fullAssetName: string;
  readonly marketId: number;
  /** `ONLINE` is the only status this bot will trade. */
  readonly status: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minOrderNotional: string;
  readonly minOrderSize: string;
  readonly maxOrderSize: string;
  readonly oraclePrice: string;
  readonly markPrice: string;
  readonly lastTradePrice: string;
  /** Current hourly funding rate. Positive means longs pay shorts. */
  readonly fundingRate: string;
  readonly nextFundingAt: number;
  readonly openInterest: string;
  readonly initialMarginFraction: string;
  readonly maintenanceMarginFraction: string;
  readonly offHoursInitialMarginFraction: string;
  /** True when the underlying is outside its regular trading hours. */
  readonly isOutsideRth: boolean;
  readonly type: string;
  /** `CRYPTO`, `EQUITIES`, `COMMODITIES`, or `INDICES`. */
  readonly category: string;
}

/**
 * The static half of a market — the fields that only change when the exchange
 * reconfigures the market, safe to cache for a process lifetime.
 *
 * Deliberately excludes `markPrice`, `oraclePrice`, `fundingRate`, and
 * `isOutsideRth`: those are live state that arrives in the same payload, and
 * caching them alongside the static fields is how stale prices end up sizing
 * an order. Read those fresh from {@link PerpMarket} or `GET /v1/bbo`.
 */
export interface MarketSpec {
  /** Market name, e.g. `NVDA-USD`. */
  readonly market: string;
  readonly marketId: number;
  readonly baseAsset: string;
  readonly status: string;
  readonly category: string;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minOrderSize: string;
  readonly maxOrderSize: string;
  readonly minOrderNotional: string;
  readonly initialMarginFraction: string;
  readonly maintenanceMarginFraction: string;
  readonly offHoursInitialMarginFraction: string;
}

export interface BookLevel {
  readonly price: string;
  readonly size: string;
}

/** `GET /v1/bbo/{market}`. Either side is null when the book is empty. */
export interface Bbo {
  readonly bestBid: BookLevel | null;
  readonly bestAsk: BookLevel | null;
  /** Epoch microseconds. */
  readonly timestamp: number;
}

/** `GET /v1/l2OrderBook/{market}`. Each level is `[price, size]`. */
export interface L2OrderBook {
  readonly bids: ReadonlyArray<readonly [string, string]>;
  readonly asks: ReadonlyArray<readonly [string, string]>;
  readonly timestamp: number;
}

/** One hourly funding observation from `GET /v1/fundingRates`. */
export interface FundingRateSample {
  readonly marketId: number;
  readonly marketDisplayName: string;
  /** Hourly rate. Positive means longs pay shorts — i.e. a short earns it. */
  readonly fundingRate: string;
  /** Funding payment time, epoch **microseconds**. */
  readonly time: number;
}

/**
 * One realized funding payment on an account, from `GET /v1/funding`.
 * `payment` is signed: **positive means the account received it**.
 */
export interface FundingPayment {
  readonly marketId: number;
  readonly marketDisplayName: string;
  readonly fundingRate: string;
  /** Signed position size when the payment was computed. */
  readonly size: string;
  readonly payment: string;
  /** Epoch microseconds. */
  readonly time: number;
}

export interface FundingPaymentsRequest {
  readonly address: string;
  readonly accountIndex?: number;
  /** Epoch ms. Defaults to 30 days before `to` when omitted. */
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
}

export interface FundingRatesRequest {
  readonly market: string;
  /** Epoch milliseconds, inclusive. */
  readonly from?: number;
  /** Epoch milliseconds, inclusive. */
  readonly to?: number;
  /** Server caps and defaults this at 1000. */
  readonly limit?: number;
}

/** Funding accrued on a position, split by settlement state. */
export interface CumulativeFunding {
  readonly allTime?: string;
  readonly sinceOpen?: string;
  readonly sinceLastChange?: string;
}

/** One open perp position. */
export interface PerpPosition {
  readonly address: string;
  readonly accountIndex: number;
  readonly marketId: number;
  readonly marketDisplayName: string;
  /** `LONG` or `SHORT`. */
  readonly side: string;
  readonly size: string;
  readonly averageEntryPrice: string;
  readonly cumulativeFunding: CumulativeFunding;
  readonly leverage: string;
  readonly marginMode: string;
  readonly marginUsed: string;
  readonly positionValueNotional: string;
  readonly unrealizedPnl: string;
  readonly markPx: string;
}

export type OrderSideName = 'BUY' | 'SELL';
export type OrderTypeName = 'LIMIT' | 'MARKET';
export type TimeInForceName = 'GTT' | 'IOC' | 'FOK' | 'ALO';

/**
 * Terminal and non-terminal order states.
 *
 * `ACK` means the gateway accepted the order and forwarded it to the matching
 * engine but has no definitive state yet — it is not a fill and not a rest.
 */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'FILLED',
  'CANCELED',
  'MARGIN_CANCELED',
  'REJECTED',
  'LIQUIDATED',
  'ADL',
  'ERROR',
]);

/** Body of `POST /v1/placeOrder`. Prices and sizes are human decimals. */
export interface OrderRequest {
  readonly address: string;
  readonly accountIndex: number;
  readonly marketId: number;
  readonly orderSide: OrderSideName;
  readonly orderType: OrderTypeName;
  readonly quantity: string;
  readonly price: string;
  readonly timeInForce: TimeInForceName;
  /** Epoch **microseconds**, at least a month ahead. Required on every order. */
  readonly goodTilTime: string;
  readonly reduceOnly?: boolean;
  readonly clientId?: string;
  /**
   * Unix **nanoseconds**, equal to `X-Timestamp` and to the signed `ct`.
   * A `bigint` because the value exceeds `Number.MAX_SAFE_INTEGER` — see
   * `signing.ts`.
   */
  readonly timestamp: bigint;
}

/** Response to a place or a status read. */
export interface OrderResponse {
  readonly address: string;
  readonly accountIndex: number;
  readonly orderId: string;
  readonly clientId?: string;
  readonly marketId: number;
  readonly marketDisplayName: string;
  readonly side: OrderSideName;
  readonly type?: OrderTypeName;
  readonly timeInForce?: string;
  readonly quantity?: string;
  readonly originalSize?: string;
  readonly price: string;
  readonly reduceOnly?: boolean;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly remainingSize?: string;
  readonly filledSize?: string;
  readonly averageFillPrice?: string;
  readonly rejectionReason?: string;
}

export interface CancelOrderRequest {
  readonly address: string;
  readonly accountIndex: number;
  readonly marketId: number;
  readonly orderId?: string;
  readonly clientId?: string;
  readonly timestamp: bigint;
}

/** `(r, s, v)` from an EIP-712 signature, as the gateway expects it. */
export interface EthereumSignature {
  readonly r: string;
  readonly s: string;
  readonly v: string;
}

export interface CreateApiKeyRequest {
  readonly address: string;
  /** 64 hex chars, no `0x`. The Ed25519 public key becomes the API key. */
  readonly publicKey: string;
  readonly apiWalletName: string;
  /**
   * Epoch ms. Must be 1–180 days ahead. Always send it explicitly: omitting
   * it makes the server verify against its own 14-day default, which will not
   * match what was signed.
   */
  readonly validUntil: number;
  readonly signature: EthereumSignature;
}

export interface CreateApiKeyResponse {
  readonly apiKey: string;
  readonly address: string;
  readonly accountIndex?: number;
  readonly validUntil?: number;
  /** Epoch microseconds. */
  readonly createdAt: number;
}

/** One registered key as `GET /v1/apiKeys` reports it. */
export interface ApiKeyInfo {
  readonly apiKey: string;
  readonly address?: string;
  readonly apiWalletName?: string;
  readonly accountIndex?: number;
  readonly validUntil?: number;
  readonly createdAt?: number;
}

/** `GET /v1/account`. Balances are in full quote currency (USDG ~ USD). */
export interface PerpAccount {
  readonly address: string;
  readonly accountIndex: number;
  readonly netQuoteBalance: string;
  readonly equity: string;
  /** `equity − Σ initial margin required`. What a new order can consume. */
  readonly freeCollateral: string;
  readonly netDeposits: string;
  readonly pendingDeposits: string;
  readonly pendingWithdrawals: string;
  /** Keyed by stringified `marketId`. */
  readonly positions: Readonly<Record<string, PerpPosition>>;
  readonly sequenceNumber: number;
}
