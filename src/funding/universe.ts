/**
 * The set of symbols this strategy can actually trade.
 *
 * A delta-neutral pair needs *both* legs, so the universe is the intersection
 * of the Arcus spot router's token list and the Arcus perp markets. Crypto
 * perps are excluded: their funding is driven by leverage demand rather than
 * the SOFR-anchored base rate that makes the RWA carry structural, and most
 * have no spot stock token to pair against anyway.
 *
 * Computed live rather than hard-coded — the exchange lists new markets and
 * the router lists new tokens, and a stale list would silently drop symbols.
 */

import type {TokenInfo} from '@arcus-xyz/arcus-spot-sdk';
import type {Hex} from 'viem';
import type {MarketSpec} from '../perps/types.js';

/** Perp categories that pair against a tokenized stock on Arcus spot. */
const RWA_CATEGORIES = new Set(['EQUITIES', 'COMMODITIES', 'INDICES']);

/** A symbol tradable on both venues. */
export interface TradablePair {
  /** Base asset ticker, e.g. `NVDA`. */
  readonly symbol: string;
  /** Perp market name, e.g. `NVDA-USD`. */
  readonly market: string;
  readonly marketId: number;
  /** Spot stock token on Robinhood Chain. */
  readonly stockTokenAddress: Hex;
  readonly stockTokenDecimals: number;
  readonly category: string;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minOrderNotional: string;
}

export interface UniverseResult {
  readonly tradable: readonly TradablePair[];
  /** RWA perp markets with no matching spot token — cannot be paired. */
  readonly perpOnly: readonly string[];
}

/**
 * Intersects the two venues' listings by ticker.
 *
 * Only `ONLINE` RWA markets are eligible: a halted or delisted market cannot
 * be shorted, and pairing against one would leave an unhedged spot long.
 */
export function buildUniverse(
  markets: readonly MarketSpec[],
  tokens: readonly TokenInfo[],
): UniverseResult {
  const byTicker = new Map<string, TokenInfo>(
    tokens.map(token => [token.symbol.toUpperCase(), token]),
  );

  const tradable: TradablePair[] = [];
  const perpOnly: string[] = [];

  for (const market of markets) {
    if (!RWA_CATEGORIES.has(market.category)) continue;
    if (market.status !== 'ONLINE') continue;

    const token = byTicker.get(market.baseAsset.toUpperCase());
    if (!token) {
      perpOnly.push(market.market);
      continue;
    }

    tradable.push({
      symbol: market.baseAsset,
      market: market.market,
      marketId: market.marketId,
      stockTokenAddress: token.address as Hex,
      stockTokenDecimals: token.decimals,
      category: market.category,
      tickSize: market.tickSize,
      stepSize: market.stepSize,
      minOrderNotional: market.minOrderNotional,
    });
  }

  return {tradable, perpOnly};
}
