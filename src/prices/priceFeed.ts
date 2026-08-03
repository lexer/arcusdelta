/**
 * A true-market price for a tokenized asset, independent of any on-chain DEX
 * or router — used as the reference the price impact gate compares an Arcus
 * quote against.
 */

import type {Hex} from 'viem';

export interface TokenPrice {
  readonly bid: number;
  readonly ask: number;
  readonly isTradingHalt: boolean;
}

export interface PriceFeed {
  getPrice(chainId: number, tokenAddress: Hex): Promise<TokenPrice>;
}

/** No listing exists for this chain/address pair. */
export class PriceNotFoundError extends Error {
  constructor(chainId: number, tokenAddress: Hex) {
    super(`No price listed for ${tokenAddress} on chain ${chainId}`);
    this.name = 'PriceNotFoundError';
  }
}
