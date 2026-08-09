/**
 * Market metadata, and the one place a human price/size pair is validated
 * against a market's grid and turned into the integers the engine signs.
 *
 * The arithmetic itself lives in `decimal.ts`; what is here is the market's
 * rules — tick and step alignment, size bounds, and the minimum notional.
 */

import {compareDecimals, multiplyDecimals, toIncrements} from './decimal.js';
import {PerpMarketNotFoundError, PerpsOrderSizeError} from './errors.js';
import type {MarketSpec, PerpMarket} from './types.js';

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
