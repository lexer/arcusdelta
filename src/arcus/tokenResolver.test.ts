import {describe, expect, it, vi} from 'vitest';
import type {TokenInfo} from '@arcus-xyz/arcus-spot-sdk';
import {TokenNotFoundError, TokenResolver} from './tokenResolver.js';

const USDG: TokenInfo = {
  chainId: 4663,
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  name: 'Global Dollar',
  decimals: 6,
  source: 'server',
  category: 'crypto',
  verified: true,
};

const NVDA: TokenInfo = {
  chainId: 4663,
  address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  symbol: 'NVDA',
  name: 'NVIDIA',
  decimals: 18,
  source: 'server',
  category: 'stock',
  verified: true,
};

const OTHER_CHAIN: TokenInfo = {...NVDA, chainId: 46630, symbol: 'mNVDA'};

function resolver(tokens: TokenInfo[] = [USDG, NVDA, OTHER_CHAIN]) {
  const getTokenList = vi.fn().mockResolvedValue(tokens);
  return {resolver: new TokenResolver({getTokenList}, 4663), getTokenList};
}

describe('TokenResolver', () => {
  it('resolves by symbol, case-insensitively', async () => {
    const {resolver: subject} = resolver();

    await expect(subject.bySymbol('usdg')).resolves.toMatchObject({
      address: USDG.address,
      decimals: 6,
    });
  });

  it('resolves by address, case-insensitively', async () => {
    const {resolver: subject} = resolver();

    await expect(
      subject.byAddress(NVDA.address.toLowerCase() as `0x${string}`),
    ).resolves.toMatchObject({symbol: 'NVDA', decimals: 18});
  });

  it('ignores tokens from other chains', async () => {
    const {resolver: subject} = resolver();

    await expect(subject.bySymbol('mNVDA')).rejects.toThrow(TokenNotFoundError);
  });

  it('rejects an unlisted token', async () => {
    const {resolver: subject} = resolver();

    await expect(subject.bySymbol('DOGE')).rejects.toThrow(TokenNotFoundError);
  });

  it('fetches the token list only once', async () => {
    const {resolver: subject, getTokenList} = resolver();

    await subject.bySymbol('USDG');
    await subject.bySymbol('NVDA');

    expect(getTokenList).toHaveBeenCalledTimes(1);
  });
});
