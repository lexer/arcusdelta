/**
 * Resolves tokens from the Arcus router's token list.
 *
 * Addresses and decimals are never hard-coded: resolving through the router
 * also proves a token is routable before any funds move. The list is fetched
 * once per process and cached.
 */

import type {TokenInfo} from '@arcus-xyz/arcus-spot-sdk';
import type {Hex} from 'viem';

export class TokenNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenNotFoundError';
  }
}

export interface TokenListSource {
  getTokenList(): Promise<TokenInfo[]>;
}

export class TokenResolver {
  private tokens: TokenInfo[] | undefined;

  constructor(
    private readonly source: TokenListSource,
    private readonly chainId: number,
  ) {}

  async bySymbol(symbol: string): Promise<TokenInfo> {
    const tokens = await this.load();
    const match = tokens.find(
      token => token.symbol.toUpperCase() === symbol.toUpperCase(),
    );
    if (!match) {
      throw new TokenNotFoundError(
        `Token ${symbol} is not listed on the Arcus router for chain ${this.chainId}`,
      );
    }
    return match;
  }

  async byAddress(address: Hex): Promise<TokenInfo> {
    const tokens = await this.load();
    const match = tokens.find(
      token => token.address.toLowerCase() === address.toLowerCase(),
    );
    if (!match) {
      throw new TokenNotFoundError(
        `Token ${address} is not listed on the Arcus router for chain ${this.chainId}`,
      );
    }
    return match;
  }

  private async load(): Promise<TokenInfo[]> {
    this.tokens ??= (await this.source.getTokenList()).filter(
      token => token.chainId === this.chainId,
    );
    return this.tokens;
  }
}
