import {describe, expect, it, vi} from 'vitest';
import {PriceNotFoundError} from './priceFeed.js';
import {createRobinhoodPriceFeed} from './robinhoodPriceFeed.js';

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';

function makeResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as Response;
}

function makeQuotesBody() {
  return {
    quotes: [
      {
        tokenSymbol: 'NVDA',
        deployments: [{contractAddress: NVDA, chainId: 4663}],
        bid: '206.66',
        ask: '206.74',
        isTradingHalt: false,
      },
      {
        tokenSymbol: 'AAPL',
        deployments: [
          {
            contractAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
            chainId: 4663,
          },
        ],
        bid: '303.74',
        ask: '303.76',
        isTradingHalt: true,
      },
    ],
  };
}

describe('createRobinhoodPriceFeed', () => {
  it('finds a listed token by chain id and contract address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(makeQuotesBody()));
    const feed = createRobinhoodPriceFeed(fetchImpl);

    const price = await feed.getPrice(4663, NVDA);

    expect(price).toEqual({bid: 206.66, ask: 206.74, isTradingHalt: false});
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.robinhood.com/rhj/prices/',
    );
  });

  it('matches the contract address case-insensitively', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(makeQuotesBody()));
    const feed = createRobinhoodPriceFeed(fetchImpl);

    const price = await feed.getPrice(4663, NVDA.toLowerCase() as typeof NVDA);

    expect(price.ask).toBe(206.74);
  });

  it('reports whether the asset is halted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(makeQuotesBody()));
    const feed = createRobinhoodPriceFeed(fetchImpl);

    const price = await feed.getPrice(
      4663,
      '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
    );

    expect(price.isTradingHalt).toBe(true);
  });

  it('throws PriceNotFoundError when no deployment matches the chain id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(makeQuotesBody()));
    const feed = createRobinhoodPriceFeed(fetchImpl);

    await expect(feed.getPrice(1, NVDA)).rejects.toThrow(PriceNotFoundError);
  });

  it('throws PriceNotFoundError when the address is not listed at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(makeQuotesBody()));
    const feed = createRobinhoodPriceFeed(fetchImpl);

    await expect(
      feed.getPrice(4663, '0x0000000000000000000000000000000000dEaD'),
    ).rejects.toThrow(PriceNotFoundError);
  });

  it('surfaces a non-ok response as an error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({}, false, 503));
    const feed = createRobinhoodPriceFeed(fetchImpl);

    await expect(feed.getPrice(4663, NVDA)).rejects.toThrow(/503/);
  });
});
