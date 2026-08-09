import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logging/logger.js';
import {AuthenticatedPerpsClient} from './authenticatedPerpsClient.js';
import {PerpsOrderRejectedError} from './errors.js';
import {toEngineOrder} from './marketRegistry.js';
import {generateApiKeyPair, PerpsRequestSigner} from './signing.js';
import type {MarketSpec} from './types.js';

const logger = createLogger('silent');
const ADDRESS = '0x742D35Cc6634C0532925a3b844Bc9e7595f2BD18';
const NOW_MS = 1_786_269_600_123;
const EXPECTED_TIMESTAMP_NS = '1786269600123000000';

const SPEC: MarketSpec = {
  market: 'NVDA-USD',
  marketId: 28,
  baseAsset: 'NVDA',
  status: 'ONLINE',
  category: 'EQUITIES',
  tickSize: '0.01',
  stepSize: '0.0000001',
  minOrderSize: '0.01',
  maxOrderSize: '100000',
  minOrderNotional: '5',
  initialMarginFraction: '0.1',
  maintenanceMarginFraction: '0.066667',
  offHoursInitialMarginFraction: '0.15',
};

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: {get: () => null},
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeClient(fetchFn: typeof fetch) {
  const pair = generateApiKeyPair();
  const client = new AuthenticatedPerpsClient({
    baseUrl: 'https://api.arcus.xyz',
    logger,
    fetchFn,
    signer: new PerpsRequestSigner(pair.privateKeyHex),
    address: ADDRESS,
    accountIndex: 0,
    now: () => NOW_MS,
  });
  return {client, publicKeyHex: pair.publicKeyHex};
}

function sentBody(fetchFn: ReturnType<typeof vi.fn>): string {
  return String(fetchFn.mock.calls[0]![1].body);
}

function sentHeaders(
  fetchFn: ReturnType<typeof vi.fn>,
): Record<string, string> {
  return fetchFn.mock.calls[0]![1].headers as Record<string, string>;
}

const accepted = {
  orderId: 'ord-1',
  status: 'ACK',
  address: ADDRESS,
  accountIndex: 0,
  marketId: 28,
  marketDisplayName: 'NVDA-USD',
  side: 'SELL',
  price: '230.00',
  createdAt: 1,
};

function placeOptions(overrides: Record<string, unknown> = {}) {
  return {
    marketId: 28,
    side: 'SELL' as const,
    orderType: 'LIMIT' as const,
    timeInForce: 'ALO' as const,
    amounts: toEngineOrder(SPEC, '230.00', '0.5'),
    ...overrides,
  };
}

describe('AuthenticatedPerpsClient.placeOrder', () => {
  it('sends the human decimals the gateway expects', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    await client.placeOrder(placeOptions());

    const body = JSON.parse(sentBody(fetchFn));
    expect(body).toMatchObject({
      address: ADDRESS,
      accountIndex: 0,
      marketId: 28,
      orderSide: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'ALO',
      price: '230.00',
      quantity: '0.5',
      reduceOnly: false,
    });
  });

  it('sends the nanosecond timestamp as an exact integer', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    await client.placeOrder(placeOptions());

    // Asserted on the raw text: parsing it back through JSON.parse would
    // itself round the value this guards against.
    expect(sentBody(fetchFn)).toContain(`"timestamp":${EXPECTED_TIMESTAMP_NS}`);
    expect(sentBody(fetchFn)).not.toContain('e+');
  });

  it('matches X-Timestamp to the body timestamp', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    await client.placeOrder(placeOptions());

    expect(sentHeaders(fetchFn)['X-Timestamp']).toBe(EXPECTED_TIMESTAMP_NS);
    expect(sentBody(fetchFn)).toContain(`"timestamp":${EXPECTED_TIMESTAMP_NS}`);
  });

  it('signs with the registered public key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client, publicKeyHex} = makeClient(fetchFn);

    await client.placeOrder(placeOptions());

    expect(sentHeaders(fetchFn)['X-API-Key']).toBe(publicKeyHex);
    expect(sentHeaders(fetchFn)['X-Signature']).toMatch(/^[0-9a-f]{128}$/);
  });

  it('sets goodTilTime beyond the one-month minimum', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    await client.placeOrder(placeOptions());

    const goodTilMicros = BigInt(JSON.parse(sentBody(fetchFn)).goodTilTime);
    const thirtyOneDaysOut = BigInt((NOW_MS + 31 * 86_400_000) * 1000);
    expect(goodTilMicros).toBeGreaterThan(thirtyOneDaysOut);
  });

  it('carries reduceOnly through to the body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    await client.placeOrder(placeOptions({reduceOnly: true}));

    expect(JSON.parse(sentBody(fetchFn)).reduceOnly).toBe(true);
  });

  it('omits clientId entirely when not supplied', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    await client.placeOrder(placeOptions());

    expect(JSON.parse(sentBody(fetchFn))).not.toHaveProperty('clientId');
  });

  it('raises on a REJECTED response instead of returning it as success', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse({
        ...accepted,
        status: 'REJECTED',
        rejectionReason: 'POST_ONLY_WOULD_CROSS',
      }),
    );
    const {client} = makeClient(fetchFn);

    const error = await client
      .placeOrder(placeOptions())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PerpsOrderRejectedError);
    expect((error as PerpsOrderRejectedError).reason).toBe(
      'POST_ONLY_WOULD_CROSS',
    );
  });

  it('returns an ACK unchanged — it is not yet a fill', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    const response = await client.placeOrder(placeOptions());

    expect(response.status).toBe('ACK');
    expect(response.orderId).toBe('ord-1');
  });
});

describe('AuthenticatedPerpsClient.cancelOrder', () => {
  it('cancels by order id and signs the cancel payload', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({}));
    const {client} = makeClient(fetchFn);

    await client.cancelOrder(28, 'ord-1');

    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      'https://api.arcus.xyz/v1/cancelOrder',
    );
    expect(JSON.parse(sentBody(fetchFn))).toMatchObject({
      marketId: 28,
      orderId: 'ord-1',
      accountIndex: 0,
    });
    expect(sentHeaders(fetchFn)['X-Signature']).toMatch(/^[0-9a-f]{128}$/);
  });

  it('has no cancelAllOrders, which would hit other keys on this wallet', () => {
    const {client} = makeClient(vi.fn());

    expect(client).not.toHaveProperty('cancelAllOrders');
  });
});

describe('AuthenticatedPerpsClient reads', () => {
  it('scopes an order lookup to this account', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(accepted));
    const {client} = makeClient(fetchFn);

    await client.getOrder('ord-1');

    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/order/ord-1');
    expect(url.searchParams.get('address')).toBe(ADDRESS);
    expect(url.searchParams.get('accountIndex')).toBe('0');
  });

  it('returns an empty list when the account has no open orders', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({orders: []}));
    const {client} = makeClient(fetchFn);

    expect(await client.getOpenOrders()).toEqual([]);
  });
});
