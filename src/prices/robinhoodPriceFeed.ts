/**
 * True exchange prices for Robinhood-tokenized assets, from Robinhood's own
 * public price feed — not derived from any DEX, router, or quote.
 *
 * The endpoint returns every listed asset in one response with no query
 * parameters, so the lookup is a client-side filter by chain id and
 * deployment contract address rather than a server-side one; the schema
 * behind the endpoint rejects unrecognized filter parameters, so this avoids
 * depending on an undocumented one.
 */

import type {Hex} from 'viem';
import {
  PriceNotFoundError,
  type PriceFeed,
  type TokenPrice,
} from './priceFeed.js';

const PRICES_URL = 'https://api.robinhood.com/rhj/prices/';

interface RawDeployment {
  readonly contractAddress: string;
  readonly chainId: number;
}

interface RawQuote {
  readonly deployments: readonly RawDeployment[];
  readonly bid: string;
  readonly ask: string;
  readonly isTradingHalt: boolean;
}

interface RawResponse {
  readonly quotes: readonly RawQuote[];
}

export function createRobinhoodPriceFeed(
  fetchImpl: typeof fetch = fetch,
): PriceFeed {
  return {
    async getPrice(chainId: number, tokenAddress: Hex): Promise<TokenPrice> {
      const response = await fetchImpl(PRICES_URL);
      if (!response.ok) {
        throw new Error(
          `Robinhood price feed returned ${response.status} ${response.statusText}`,
        );
      }

      const body = (await response.json()) as RawResponse;
      const quote = body.quotes.find(candidate =>
        candidate.deployments.some(
          deployment =>
            deployment.chainId === chainId &&
            deployment.contractAddress.toLowerCase() ===
              tokenAddress.toLowerCase(),
        ),
      );
      if (!quote) throw new PriceNotFoundError(chainId, tokenAddress);

      return {
        bid: Number(quote.bid),
        ask: Number(quote.ask),
        isTradingHalt: quote.isTradingHalt,
      };
    },
  };
}
