import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logging/logger.js';
import {ArcusPerpsClient} from './arcusPerpsClient.js';
import {
  PerpsApiError,
  PerpsRateLimitError,
  PerpsTransportError,
} from './errors.js';

const logger = createLogger('silent');

function makeResponse(
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: {get: (name: string) => headers[name] ?? null},
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

/** Records the sleeps a retry loop asked for instead of waiting on them. */
function makeSleepSpy() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

function makeClient(
  fetchFn: typeof fetch,
  overrides: {
    maxRateLimitRetries?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  return new ArcusPerpsClient({
    baseUrl: 'https://api.arcus.xyz',
    logger,
    fetchFn,
    ...overrides,
  });
}

/** The URL the client actually requested, as a string. */
function requestedUrl(fetchFn: ReturnType<typeof vi.fn>): string {
  return String(fetchFn.mock.calls[0]![0]);
}

describe('ArcusPerpsClient', () => {
  it('unwraps the markets envelope', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeResponse({markets: [{marketId: 28}]}));

    const markets = await makeClient(fetchFn).getMarkets();

    expect(markets).toEqual([{marketId: 28}]);
    expect(requestedUrl(fetchFn)).toBe('https://api.arcus.xyz/v1/markets');
  });

  it('trims a trailing slash off the base url', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({markets: []}));
    const client = new ArcusPerpsClient({
      baseUrl: 'https://api.arcus.xyz/',
      logger,
      fetchFn,
    });

    await client.getMarkets();

    expect(requestedUrl(fetchFn)).toBe('https://api.arcus.xyz/v1/markets');
  });

  it('puts the market name in the path for bbo', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeResponse({bestBid: null, bestAsk: null}));

    await makeClient(fetchFn).getBbo('NVDA-USD');

    expect(requestedUrl(fetchFn)).toBe('https://api.arcus.xyz/v1/bbo/NVDA-USD');
  });

  it('unwraps the funding rates envelope and passes the window through', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeResponse({fundingRates: [{fundingRate: '0.1'}]}));

    const rates = await makeClient(fetchFn).getFundingRates({
      market: 'NVDA-USD',
      from: 1000,
      to: 2000,
      limit: 500,
    });

    expect(rates).toEqual([{fundingRate: '0.1'}]);
    const url = new URL(requestedUrl(fetchFn));
    expect(url.pathname).toBe('/v1/fundingRates');
    expect(url.searchParams.get('market')).toBe('NVDA-USD');
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('2000');
    expect(url.searchParams.get('limit')).toBe('500');
  });

  it('omits query parameters that were not supplied', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({fundingRates: []}));

    await makeClient(fetchFn).getFundingRates({market: 'NVDA-USD'});

    const url = new URL(requestedUrl(fetchFn));
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('defaults the account index to 0', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({equity: '100'}));

    await makeClient(fetchFn).getAccount('0xabc');

    const url = new URL(requestedUrl(fetchFn));
    expect(url.searchParams.get('address')).toBe('0xabc');
    expect(url.searchParams.get('accountIndex')).toBe('0');
  });

  it('raises PerpsApiError carrying the status and the gateway message', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(makeResponse({error: 'Not found'}, false, 404));

    const error = await makeClient(fetchFn)
      .getBbo('WAT-USD')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PerpsApiError);
    expect((error as PerpsApiError).status).toBe(404);
    expect((error as PerpsApiError).path).toBe('/v1/bbo/WAT-USD');
    expect((error as PerpsApiError).message).toContain('Not found');
  });

  it('raises PerpsTransportError when the request never lands', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(makeClient(fetchFn).getMarkets()).rejects.toThrow(
      PerpsTransportError,
    );
  });

  it('retries a 429 after the gateway-supplied Retry-After, then succeeds', async () => {
    const {slept, sleep} = makeSleepSpy();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({error: 'rate limited'}, false, 429, {'Retry-After': '3'}),
      )
      .mockResolvedValueOnce(makeResponse({markets: [{marketId: 1}]}));

    const markets = await makeClient(fetchFn, {sleep}).getMarkets();

    expect(markets).toEqual([{marketId: 1}]);
    expect(slept).toEqual([3000]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('gives up with PerpsRateLimitError once the retry budget is spent', async () => {
    const {slept, sleep} = makeSleepSpy();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        makeResponse({error: 'rate limited'}, false, 429, {'Retry-After': '1'}),
      );

    const error = await makeClient(fetchFn, {maxRateLimitRetries: 2, sleep})
      .getMarkets()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PerpsRateLimitError);
    expect((error as PerpsRateLimitError).retryAfterSeconds).toBe(1);
    expect(slept).toEqual([1000, 1000]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('falls back to a positive delay when Retry-After is missing', async () => {
    const {slept, sleep} = makeSleepSpy();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({error: 'rate limited'}, false, 429))
      .mockResolvedValueOnce(makeResponse({markets: []}));

    await makeClient(fetchFn, {sleep}).getMarkets();

    expect(slept).toEqual([2000]);
  });

  it('surfaces a non-JSON error body without throwing on the parse', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: {get: () => null},
      text: () => Promise.resolve('<html>upstream down</html>'),
    } as unknown as Response);

    const error = await makeClient(fetchFn)
      .getMarkets()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PerpsApiError);
    expect((error as PerpsApiError).body).toBe('<html>upstream down</html>');
    expect((error as PerpsApiError).message).toContain('502');
  });
});
