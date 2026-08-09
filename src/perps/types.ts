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
