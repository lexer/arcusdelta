import {describe, expect, it, vi} from 'vitest';
import {createNullJournal} from '../journal/executionJournal.js';
import type {
  ExecutionEvent,
  ExecutionJournal,
  PerpFillEvent,
} from '../journal/executionJournal.js';
import {createLogger} from '../logging/logger.js';
import {PerpsOrderRejectedError} from './errors.js';
import {MakerOrderExecutor} from './makerOrderExecutor.js';
import type {MarketSpec, OrderResponse} from './types.js';

const logger = createLogger('silent');

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

function makeOrder(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    address: '0xabc',
    accountIndex: 0,
    orderId: 'ord-1',
    marketId: 28,
    marketDisplayName: 'NVDA-USD',
    side: 'SELL',
    price: '224.38',
    status: 'OPEN',
    createdAt: 1,
    filledSize: '0',
    ...overrides,
  };
}

function memoryJournal(): ExecutionJournal & {events: ExecutionEvent[]} {
  const events: ExecutionEvent[] = [];
  return {
    events,
    record: (event: ExecutionEvent) => void events.push(event),
    read: () => [...events],
  };
}

interface Harness {
  placeOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
  getOrder: ReturnType<typeof vi.fn>;
  getBbo: ReturnType<typeof vi.fn>;
}

function makeExecutor(
  overrides: Partial<Harness> = {},
  journal: ExecutionJournal = createNullJournal(),
) {
  const harness: Harness = {
    placeOrder: vi.fn().mockResolvedValue(makeOrder()),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    getOrder: vi.fn().mockResolvedValue(makeOrder()),
    getBbo: vi.fn().mockResolvedValue({
      bestBid: {price: '224.25', size: '10'},
      bestAsk: {price: '224.38', size: '10'},
      timestamp: 1,
    }),
    ...overrides,
  };
  const executor = new MakerOrderExecutor({
    client: {
      placeOrder: harness.placeOrder,
      cancelOrder: harness.cancelOrder,
      getOrder: harness.getOrder,
    },
    marketData: {getBbo: harness.getBbo},
    journal,
    logger,
    sleep: async () => {},
  });
  return {executor, ...harness};
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    tradeId: 'trade-1',
    symbol: 'NVDA',
    spec: SPEC,
    side: 'SELL' as const,
    targetQuantity: '0.5',
    repriceSeconds: 3,
    maxAttempts: 3,
    pollIntervalMs: 1000,
    ...overrides,
  };
}

describe('MakerOrderExecutor.fill', () => {
  it('posts a sell at the best ask, never through it', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request());

    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        timeInForce: 'ALO',
        side: 'SELL',
        amounts: expect.objectContaining({price: '224.38', quantity: '0.5'}),
      }),
    );
  });

  it('posts a buy at the best bid', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request({side: 'BUY'}));

    expect(placeOrder.mock.calls[0]![0].amounts.price).toBe('224.25');
  });

  it('improves a sell inside the spread for queue priority', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request({improveTicks: 1}));

    // Best ask 224.38, one tick better, still above the 224.25 bid.
    expect(placeOrder.mock.calls[0]![0].amounts.price).toBe('224.37');
  });

  it('improves a buy upward, toward the ask', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request({side: 'BUY', improveTicks: 1}));

    expect(placeOrder.mock.calls[0]![0].amounts.price).toBe('224.26');
  });

  it('clamps improvement so a sell never crosses the bid', async () => {
    const {executor, placeOrder} = makeExecutor({
      getBbo: vi.fn().mockResolvedValue({
        // One tick wide: 224.37 / 224.38.
        bestBid: {price: '224.37', size: '10'},
        bestAsk: {price: '224.38', size: '10'},
        timestamp: 1,
      }),
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request({improveTicks: 5}));

    // Cannot go below one tick above the bid.
    expect(placeOrder.mock.calls[0]![0].amounts.price).toBe('224.38');
  });

  it('clamps improvement so a buy never crosses the ask', async () => {
    const {executor, placeOrder} = makeExecutor({
      getBbo: vi.fn().mockResolvedValue({
        bestBid: {price: '224.37', size: '10'},
        bestAsk: {price: '224.38', size: '10'},
        timestamp: 1,
      }),
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request({side: 'BUY', improveTicks: 5}));

    expect(placeOrder.mock.calls[0]![0].amounts.price).toBe('224.37');
  });

  it('joins the touch when no improvement is asked for', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request());

    expect(placeOrder.mock.calls[0]![0].amounts.price).toBe('224.38');
  });

  it('reports a complete fill without cancelling', async () => {
    const {executor, cancelOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    const result = await executor.fill(request());

    expect(result).toMatchObject({
      filledQuantity: '0.5',
      averageFillPrice: '224.38',
      attempts: 1,
      complete: true,
    });
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('re-prices after the window and carries the remainder forward', async () => {
    const getBbo = vi
      .fn()
      .mockResolvedValueOnce({
        bestBid: {price: '224.25', size: '10'},
        bestAsk: {price: '224.38', size: '10'},
        timestamp: 1,
      })
      .mockResolvedValue({
        bestBid: {price: '224.30', size: '10'},
        bestAsk: {price: '224.44', size: '10'},
        timestamp: 2,
      });
    const {executor, placeOrder} = makeExecutor({
      getBbo,
      getOrder: vi
        .fn()
        // First attempt: partial, then cancelled.
        .mockResolvedValueOnce(makeOrder({status: 'OPEN', filledSize: '0'}))
        .mockResolvedValueOnce(
          makeOrder({status: 'CANCELED', filledSize: '0.2'}),
        )
        // Second attempt: the rest fills.
        .mockResolvedValue(
          makeOrder({orderId: 'ord-2', status: 'FILLED', filledSize: '0.3'}),
        ),
      placeOrder: vi
        .fn()
        .mockResolvedValueOnce(makeOrder())
        .mockResolvedValue(makeOrder({orderId: 'ord-2'})),
    });

    const result = await executor.fill(request({repriceSeconds: 1}));

    expect(placeOrder.mock.calls[1]![0].amounts).toMatchObject({
      price: '224.44',
      quantity: '0.3',
    });
    expect(result.filledQuantity).toBe('0.5');
    expect(result.complete).toBe(true);
  });

  it('weights the average fill price by size across attempts', async () => {
    const getBbo = vi
      .fn()
      .mockResolvedValueOnce({
        bestBid: {price: '100', size: '10'},
        bestAsk: {price: '100', size: '10'},
        timestamp: 1,
      })
      .mockResolvedValue({
        bestBid: {price: '200', size: '10'},
        bestAsk: {price: '200', size: '10'},
        timestamp: 2,
      });
    const {executor} = makeExecutor({
      getBbo,
      getOrder: vi
        .fn()
        .mockResolvedValueOnce(makeOrder({status: 'OPEN', filledSize: '0'}))
        .mockResolvedValueOnce(
          makeOrder({status: 'CANCELED', filledSize: '0.1'}),
        )
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.3'})),
    });

    const result = await executor.fill(
      request({targetQuantity: '0.4', repriceSeconds: 1}),
    );

    // 0.1 @ 100 and 0.3 @ 200 -> 175.
    expect(result.averageFillPrice).toBe('175');
  });

  it('treats a post-only rejection as a re-price, not a failure', async () => {
    const {executor, placeOrder} = makeExecutor({
      placeOrder: vi
        .fn()
        .mockRejectedValueOnce(
          new PerpsOrderRejectedError('would cross', 'POST_ONLY_WOULD_CROSS'),
        )
        .mockResolvedValue(makeOrder()),
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    const result = await executor.fill(request());

    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(result.filledQuantity).toBe('0.5');
  });

  it('propagates a rejection that is not a post-only cross', async () => {
    const {executor} = makeExecutor({
      placeOrder: vi
        .fn()
        .mockRejectedValue(
          new PerpsOrderRejectedError('bad margin', 'INSUFFICIENT_MARGIN'),
        ),
    });

    await expect(executor.fill(request())).rejects.toThrow(
      PerpsOrderRejectedError,
    );
  });

  it('re-reads after the cancel, so a late fill is not lost', async () => {
    const {executor} = makeExecutor({
      getOrder: vi
        .fn()
        // Poll during the window: nothing filled.
        .mockResolvedValueOnce(makeOrder({status: 'OPEN', filledSize: '0'}))
        // After the cancel: it actually filled in the meantime.
        .mockResolvedValueOnce(
          makeOrder({status: 'FILLED', filledSize: '0.5'}),
        ),
    });

    const result = await executor.fill(
      request({repriceSeconds: 1, maxAttempts: 1}),
    );

    expect(result.filledQuantity).toBe('0.5');
  });

  it('gives up after maxAttempts and reports what filled', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi.fn().mockResolvedValue(makeOrder({status: 'CANCELED'})),
    });

    const result = await executor.fill(
      request({repriceSeconds: 1, maxAttempts: 2}),
    );

    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      filledQuantity: '0',
      averageFillPrice: undefined,
      complete: false,
    });
  });

  it('stops once the remainder is too small to place', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValueOnce(makeOrder({status: 'OPEN', filledSize: '0'}))
        .mockResolvedValueOnce(
          // Leaves 0.001 — under the 0.01 minOrderSize.
          makeOrder({status: 'CANCELED', filledSize: '0.499'}),
        ),
    });

    const result = await executor.fill(
      request({repriceSeconds: 1, maxAttempts: 5}),
    );

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(result.filledQuantity).toBe('0.499');
    expect(result.complete).toBe(false);
  });

  it('stops when the side it must join has no liquidity', async () => {
    const {executor, placeOrder} = makeExecutor({
      getBbo: vi
        .fn()
        .mockResolvedValue({bestBid: null, bestAsk: null, timestamp: 1}),
    });

    const result = await executor.fill(request());

    expect(placeOrder).not.toHaveBeenCalled();
    expect(result.filledQuantity).toBe('0');
  });

  it('cancels only the order it placed, by id', async () => {
    const {executor, cancelOrder} = makeExecutor({
      getOrder: vi.fn().mockResolvedValue(makeOrder({status: 'OPEN'})),
    });

    await executor.fill(request({repriceSeconds: 1, maxAttempts: 1}));

    expect(cancelOrder).toHaveBeenCalledWith(28, 'ord-1');
  });

  it('passes reduceOnly through to the order', async () => {
    const {executor, placeOrder} = makeExecutor({
      getOrder: vi
        .fn()
        .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
    });

    await executor.fill(request({reduceOnly: true}));

    expect(placeOrder.mock.calls[0]![0].reduceOnly).toBe(true);
  });

  it('journals each fill as a maker fill', async () => {
    const journal = memoryJournal();
    const {executor} = makeExecutor(
      {
        getOrder: vi
          .fn()
          .mockResolvedValue(makeOrder({status: 'FILLED', filledSize: '0.5'})),
      },
      journal,
    );

    await executor.fill(request());

    expect(journal.events).toHaveLength(1);
    expect(journal.events[0] as PerpFillEvent).toMatchObject({
      kind: 'perp-fill',
      symbol: 'NVDA',
      market: 'NVDA-USD',
      side: 'SELL',
      filledQuantity: '0.5',
      limitPrice: '224.38',
      maker: true,
      reduceOnly: false,
    });
  });

  it('journals nothing when nothing filled', async () => {
    const journal = memoryJournal();
    const {executor} = makeExecutor(
      {getOrder: vi.fn().mockResolvedValue(makeOrder({status: 'CANCELED'}))},
      journal,
    );

    await executor.fill(request({repriceSeconds: 1, maxAttempts: 1}));

    expect(journal.events).toHaveLength(0);
  });
});
