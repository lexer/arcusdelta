/**
 * Market metadata and the decimal <-> engine-integer conversions the order
 * path depends on.
 *
 * The Arcus matching engine takes prices in **ticks** (`price / tickSize`) and
 * sizes in **quantums** (`size / stepSize`), both exact integers, and those
 * same integers go into the signed order payload. A rounding error here is not
 * a rejected order — it is a *validly signed order for the wrong amount*, so
 * every conversion runs in `bigint` on scaled decimal strings and throws
 * rather than rounding.
 */

import {formatUnits, parseUnits} from 'viem';
import {
  PerpMarketNotFoundError,
  PerpsAlignmentError,
  PerpsOrderSizeError,
} from './errors.js';
import type {MarketSpec, PerpMarket} from './types.js';

/**
 * Fixed-point scale for every conversion below. Comfortably above the
 * exchange's finest increment (BTC's `stepSize` is 1e-8) and matches the
 * 18-decimal convention the rest of the codebase already uses for atoms.
 */
const SCALE = 18;

/** Decimal string -> scaled bigint. Throws on anything `parseUnits` rejects. */
function scale(value: string): bigint {
  return parseUnits(value, SCALE);
}

/** Scaled bigint -> decimal string, trailing zeros trimmed. */
function unscale(value: bigint): string {
  return formatUnits(value, SCALE);
}

/**
 * Exact integer count of `increment` in `value`.
 *
 * Throws {@link PerpsAlignmentError} when `value` is not a whole multiple —
 * the engine would reject it with `Tick`, and silently rounding here would
 * change the size or price the operator asked for.
 */
export function toIncrements(value: string, increment: string): bigint {
  const scaledIncrement = scale(increment);
  if (scaledIncrement <= 0n) {
    throw new PerpsAlignmentError(
      `Increment must be positive, got ${increment}`,
      value,
      increment,
    );
  }

  const scaledValue = scale(value);
  if (scaledValue % scaledIncrement !== 0n) {
    throw new PerpsAlignmentError(
      `${value} is not a whole multiple of ${increment}`,
      value,
      increment,
    );
  }
  return scaledValue / scaledIncrement;
}

/** Largest multiple of `increment` at or below `value`. Never negative. */
export function floorToIncrement(value: string, increment: string): string {
  const scaledIncrement = scale(increment);
  if (scaledIncrement <= 0n) {
    throw new PerpsAlignmentError(
      `Increment must be positive, got ${increment}`,
      value,
      increment,
    );
  }

  const scaledValue = scale(value);
  // bigint division truncates toward zero, which is the wrong direction for a
  // negative value — a residual delta can legitimately be negative.
  let steps = scaledValue / scaledIncrement;
  if (scaledValue % scaledIncrement !== 0n && scaledValue < 0n) steps -= 1n;
  return unscale(steps * scaledIncrement);
}

/** Product of two decimal strings, exact, as a decimal string. */
export function multiplyDecimals(a: string, b: string): string {
  return unscale((scale(a) * scale(b)) / 10n ** BigInt(SCALE));
}

/** `a / b` as a decimal string, truncated to {@link SCALE} places. */
export function divideDecimals(a: string, b: string): string {
  const divisor = scale(b);
  if (divisor === 0n) throw new RangeError('Division by zero');
  return unscale((scale(a) * 10n ** BigInt(SCALE)) / divisor);
}

/** Signed comparison of two decimal strings. */
export function compareDecimals(a: string, b: string): number {
  const left = scale(a);
  const right = scale(b);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * A price/size pair in both the human form the HTTP body carries and the
 * integer form the signature covers.
 *
 * They are produced together, from one validation, so a body and a signature
 * can never describe different amounts.
 */
export interface EngineOrderAmounts {
  readonly price: string;
  readonly quantity: string;
  readonly priceTicks: bigint;
  readonly quantityQuantums: bigint;
}

/**
 * Validates a price and size against a market's grid and limits, and converts
 * them to engine integers.
 *
 * Every rejection here is one the engine would make anyway — `Tick`,
 * `OrderSizeTooLarge`, or the $5 minimum notional — caught before a signature
 * exists rather than after a round trip.
 */
export function toEngineOrder(
  spec: MarketSpec,
  price: string,
  quantity: string,
  options: {readonly reduceOnly?: boolean} = {},
): EngineOrderAmounts {
  const priceTicks = toIncrements(price, spec.tickSize);
  const quantityQuantums = toIncrements(quantity, spec.stepSize);

  if (priceTicks <= 0n) {
    throw new PerpsOrderSizeError(`Price must be positive, got ${price}`);
  }
  if (quantityQuantums <= 0n) {
    throw new PerpsOrderSizeError(`Quantity must be positive, got ${quantity}`);
  }
  if (compareDecimals(quantity, spec.maxOrderSize) > 0) {
    throw new PerpsOrderSizeError(
      `Quantity ${quantity} exceeds ${spec.market} maxOrderSize ${spec.maxOrderSize}`,
    );
  }
  if (compareDecimals(quantity, spec.minOrderSize) < 0) {
    throw new PerpsOrderSizeError(
      `Quantity ${quantity} is below ${spec.market} minOrderSize ${spec.minOrderSize}`,
    );
  }

  // Reduce-only orders are exempt from the minimum notional, since closing a
  // small remainder is exactly what they are for.
  if (options.reduceOnly !== true) {
    const notional = multiplyDecimals(price, quantity);
    if (compareDecimals(notional, spec.minOrderNotional) < 0) {
      throw new PerpsOrderSizeError(
        `Notional ${notional} is below ${spec.market} minOrderNotional ${spec.minOrderNotional}`,
      );
    }
  }

  return {price, quantity, priceTicks, quantityQuantums};
}

/** Keeps only the fields that do not change between polls. */
export function toMarketSpec(market: PerpMarket): MarketSpec {
  return {
    market: market.marketDisplayName,
    marketId: market.marketId,
    baseAsset: market.baseAsset,
    status: market.status,
    category: market.category,
    tickSize: market.tickSize,
    stepSize: market.stepSize,
    minOrderSize: market.minOrderSize,
    maxOrderSize: market.maxOrderSize,
    minOrderNotional: market.minOrderNotional,
    initialMarginFraction: market.initialMarginFraction,
    maintenanceMarginFraction: market.maintenanceMarginFraction,
    offHoursInitialMarginFraction: market.offHoursInitialMarginFraction,
  };
}

export interface MarketSource {
  getMarkets(): Promise<PerpMarket[]>;
}

/**
 * Caches the static half of `GET /v1/markets` for the process lifetime.
 *
 * Only {@link MarketSpec} is cached — never mark price, oracle price, funding
 * rate, or `isOutsideRth`, which arrive in the same payload but are live state.
 * Callers that need those go back to the source (or `GET /v1/bbo`) each time,
 * which is what {@link MarketRegistry.live} is for.
 */
export class MarketRegistry {
  private specs: Map<string, MarketSpec> | undefined;

  constructor(private readonly source: MarketSource) {}

  /** Every market's static spec, in the order the gateway returned them. */
  async all(): Promise<MarketSpec[]> {
    return [...(await this.load()).values()];
  }

  /** Looks up by market name, e.g. `NVDA-USD`. Case-insensitive. */
  async byMarket(market: string): Promise<MarketSpec> {
    const specs = await this.load();
    const match = specs.get(market.toUpperCase());
    if (!match) {
      throw new PerpMarketNotFoundError(
        `No Arcus perp market named "${market}"`,
      );
    }
    return match;
  }

  /** Looks up by base asset, e.g. `NVDA`. Case-insensitive. */
  async byBaseAsset(baseAsset: string): Promise<MarketSpec> {
    const specs = await this.load();
    const wanted = baseAsset.toUpperCase();
    const match = [...specs.values()].find(
      spec => spec.baseAsset.toUpperCase() === wanted,
    );
    if (!match) {
      throw new PerpMarketNotFoundError(
        `No Arcus perp market for base asset "${baseAsset}"`,
      );
    }
    return match;
  }

  /**
   * A market's *live* row, re-fetched every call. Use this — not the cached
   * spec — for anything that reads a price, a funding rate, or the trading
   * hours flag.
   */
  async live(market: string): Promise<PerpMarket> {
    const wanted = market.toUpperCase();
    const match = (await this.source.getMarkets()).find(
      candidate => candidate.marketDisplayName.toUpperCase() === wanted,
    );
    if (!match) {
      throw new PerpMarketNotFoundError(
        `No Arcus perp market named "${market}"`,
      );
    }
    return match;
  }

  private async load(): Promise<Map<string, MarketSpec>> {
    if (this.specs === undefined) {
      const markets = await this.source.getMarkets();
      this.specs = new Map(
        markets.map(market => [
          market.marketDisplayName.toUpperCase(),
          toMarketSpec(market),
        ]),
      );
    }
    return this.specs;
  }
}
