import {describe, expect, it, vi} from 'vitest';
import type {
  ExecutionEvent,
  ExecutionJournal,
} from '../journal/executionJournal.js';
import {createLogger} from '../logging/logger.js';
import type {MarketSpec} from '../perps/types.js';
import {PairCloseService, splitQuantity} from './pairCloseService.js';

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
  initialMarginFraction: '0.05',
  maintenanceMarginFraction: '0.033',
  offHoursInitialMarginFraction: '0.075',
};

function memoryJournal(): ExecutionJournal & {events: ExecutionEvent[]} {
  const events: ExecutionEvent[] = [];
  return {
    events,
    record: (e: ExecutionEvent) => void events.push(e),
    read: () => [...events],
  };
}

function makeService(
  overrides: {
    closeShort?: ReturnType<typeof vi.fn>;
    executeSell?: ReturnType<typeof vi.fn>;
    balanceAtoms?: bigint;
    journal?: ExecutionJournal;
    order?: string[];
  } = {},
) {
  const order = overrides.order ?? [];
  const closeShort =
    overrides.closeShort ??
    vi.fn(async (r: {quantity: string}) => {
      order.push(`perp:${r.quantity}`);
      return {
        filledQuantity: r.quantity,
        averageFillPrice: '218.00',
        attempts: 1,
        orderIds: ['o1'],
        complete: true,
      };
    });
  const executeSell =
    overrides.executeSell ??
    vi.fn(async (r: {sellAmountAtoms: bigint}) => {
      order.push(`spot:${r.sellAmountAtoms}`);
      return {
        tradeId: 't',
        txHashes: ['0xabc' as const],
        orderId: undefined,
        sellAmount: r.sellAmountAtoms.toString(),
        buyAmount: '1000000',
        minBuyAmount: '999000',
      };
    });
  const journal = overrides.journal ?? memoryJournal();
  const service = new PairCloseService({
    shorts: {closeShort, positionFor: vi.fn()},
    spotSeller: {executeSell},
    readSpotBalanceAtoms: async () =>
      overrides.balanceAtoms ?? 23_000000000000000000n,
    journal,
    logger,
    sleep: async () => {},
  });
  return {service, closeShort, executeSell, journal, order};
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    tradeId: 'close-1',
    symbol: 'NVDA',
    spec: SPEC,
    spot: {
      address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as const,
      decimals: 18,
    },
    quantity: '3',
    chunks: 3,
    intervalSeconds: 30,
    repriceSeconds: 60,
    maxAttempts: 5,
    slippageBps: 50,
    ...overrides,
  };
}

describe('splitQuantity', () => {
  it('splits evenly and sums to exactly the total', () => {
    const pieces = splitQuantity('3', 3, '0.0000001');

    expect(pieces).toEqual(['1', '1', '1']);
  });

  it('gives the remainder to the last piece', () => {
    const pieces = splitQuantity('23.003', 4, '0.0000001');

    expect(pieces).toHaveLength(4);
    expect(pieces.slice(0, 3).every(p => p === '5.75075')).toBe(true);
    expect(pieces[3]).toBe('5.75075');
  });

  it('keeps every piece on the step grid', () => {
    const pieces = splitQuantity('1', 3, '0.01');

    expect(pieces.slice(0, 2)).toEqual(['0.33', '0.33']);
    expect(pieces[2]).toBe('0.34');
  });

  it('reduces the chunk count rather than emitting a zero piece', () => {
    // 0.05 into 10 pieces at a 0.01 step would round each to zero.
    const pieces = splitQuantity('0.05', 10, '0.01');

    expect(pieces.every(p => Number(p) > 0)).toBe(true);
    expect(pieces.length).toBeLessThan(10);
  });

  it('handles a single chunk', () => {
    expect(splitQuantity('23.003', 1, '0.0000001')).toEqual(['23.003']);
  });
});

describe('PairCloseService.close', () => {
  it('unwinds the perp before selling spot, every chunk', async () => {
    const {service, order} = makeService();

    await service.close(request());

    // Strict alternation: never a spot sell before its perp buy-back.
    expect(order).toEqual([
      'perp:1',
      'spot:1000000000000000000',
      'perp:1',
      'spot:1000000000000000000',
      'perp:1',
      'spot:1000000000000000000',
    ]);
  });

  it('sells exactly what the perp leg actually closed', async () => {
    // A partial maker fill must not lead to over-selling spot.
    const closeShort = vi.fn().mockResolvedValue({
      filledQuantity: '0.4',
      averageFillPrice: '218',
      attempts: 2,
      orderIds: ['o1'],
      complete: false,
    });
    const {service, executeSell} = makeService({closeShort});

    await service.close(request({quantity: '1', chunks: 1}));

    expect(executeSell.mock.calls[0]![0].sellAmountAtoms).toBe(
      400000000000000000n,
    );
  });

  it('caps the spot sell at the balance actually held', async () => {
    const {service, executeSell} = makeService({
      balanceAtoms: 500000000000000000n,
    });

    await service.close(request({quantity: '1', chunks: 1}));

    expect(executeSell.mock.calls[0]![0].sellAmountAtoms).toBe(
      500000000000000000n,
    );
  });

  it('reports a complete unwind', async () => {
    const {service} = makeService();

    const result = await service.close(request());

    expect(result.perpClosed).toBe('3');
    expect(result.complete).toBe(true);
    expect(result.stoppedBecause).toBeUndefined();
    expect(result.chunks).toHaveLength(3);
  });

  it('stops without selling when a chunk will not fill as a maker', async () => {
    const closeShort = vi.fn().mockResolvedValue({
      filledQuantity: '0',
      averageFillPrice: undefined,
      attempts: 5,
      orderIds: [],
      complete: false,
    });
    const {service, executeSell} = makeService({closeShort});

    const result = await service.close(request());

    expect(executeSell).not.toHaveBeenCalled();
    expect(result.complete).toBe(false);
    expect(result.stoppedBecause).toContain('still hedged');
  });

  it('stops after the first chunk fails, leaving the rest hedged', async () => {
    const closeShort = vi
      .fn()
      .mockResolvedValueOnce({
        filledQuantity: '1',
        averageFillPrice: '218',
        attempts: 1,
        orderIds: ['o1'],
        complete: true,
      })
      .mockResolvedValue({
        filledQuantity: '0',
        averageFillPrice: undefined,
        attempts: 5,
        orderIds: [],
        complete: false,
      });
    const {service, executeSell} = makeService({closeShort});

    const result = await service.close(request());

    expect(result.perpClosed).toBe('1');
    expect(executeSell).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
  });

  it('reports being net long when the spot sell fails after a buy-back', async () => {
    const executeSell = vi.fn().mockRejectedValue(new Error('NO_QUOTES'));
    const {service} = makeService({executeSell});

    const result = await service.close(request());

    expect(result.stoppedBecause).toContain('net LONG');
    expect(result.stoppedBecause).toContain('NVDA');
    expect(result.perpClosed).toBe('1');
  });

  it('does not cross the spread to fix a failed spot sell', async () => {
    const executeSell = vi.fn().mockRejectedValue(new Error('NO_QUOTES'));
    const {service} = makeService({executeSell});

    await service.close(request());

    // One attempt, then stop. No retry, no taker fallback.
    expect(executeSell).toHaveBeenCalledTimes(1);
  });

  it('stops when there is no spot left to sell', async () => {
    const {service} = makeService({balanceAtoms: 0n});

    const result = await service.close(request());

    expect(result.stoppedBecause).toContain('no spot balance');
  });

  it('journals every spot sell', async () => {
    const journal = memoryJournal();
    const {service} = makeService({journal});

    await service.close(request());

    expect(journal.events).toHaveLength(3);
    expect(journal.events[0]).toMatchObject({
      kind: 'spot-fill',
      direction: 'sell',
      sellSymbol: 'NVDA',
      buySymbol: 'USDG',
      // Human decimals, so the cost-basis reader can net it correctly.
      sellAmount: '1',
      buyAmount: '1',
    });
  });

  it('surfaces a perp failure without touching spot', async () => {
    const closeShort = vi.fn().mockRejectedValue(new Error('margin'));
    const {service, executeSell} = makeService({closeShort});

    const result = await service.close(request());

    expect(executeSell).not.toHaveBeenCalled();
    expect(result.stoppedBecause).toContain('perp buy-back failed');
  });
});
