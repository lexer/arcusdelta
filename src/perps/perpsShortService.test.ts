import {describe, expect, it, vi} from 'vitest';
import {createNullJournal} from '../journal/executionJournal.js';
import type {
  ExecutionEvent,
  ExecutionJournal,
  PerpFillEvent,
} from '../journal/executionJournal.js';
import {createLogger} from '../logging/logger.js';
import {PerpsMarginError, PerpsPositionConflictError} from './errors.js';
import {
  isManagedPair,
  PerpsShortService,
  signedSize,
} from './perpsShortService.js';
import type {MarketSpec, PerpPosition} from './types.js';

const logger = createLogger('silent');
const ADDRESS = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';

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
  offHoursInitialMarginFraction: '0.1',
};

function makePosition(overrides: Partial<PerpPosition> = {}): PerpPosition {
  return {
    address: ADDRESS,
    accountIndex: 0,
    marketId: 28,
    marketDisplayName: 'NVDA-USD',
    side: 'SHORT',
    size: '-0.5',
    averageEntryPrice: '224.38',
    cumulativeFunding: {allTime: '0.1'},
    leverage: '1',
    marginMode: 'CROSS',
    marginUsed: '112',
    positionValueNotional: '-112',
    unrealizedPnl: '0',
    markPx: '224.38',
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

function makeService(
  overrides: {
    positions?: unknown;
    freeCollateral?: string;
    placeOrder?: ReturnType<typeof vi.fn>;
    fill?: ReturnType<typeof vi.fn>;
    journal?: ExecutionJournal;
  } = {},
) {
  const getPositions = vi.fn().mockResolvedValue(overrides.positions ?? []);
  const getAccount = vi
    .fn()
    .mockResolvedValue({freeCollateral: overrides.freeCollateral ?? '10000'});
  const placeOrder =
    overrides.placeOrder ??
    vi.fn().mockResolvedValue({
      orderId: 'ord-unwind',
      status: 'FILLED',
      filledSize: '0.5',
    });
  const fill =
    overrides.fill ??
    vi.fn().mockResolvedValue({
      filledQuantity: '0.5',
      averageFillPrice: '224.38',
      attempts: 1,
      orderIds: ['ord-1'],
      complete: true,
    });
  const journal = overrides.journal ?? createNullJournal();

  const service = new PerpsShortService({
    client: {placeOrder},
    marketData: {getAccount, getPositions},
    executor: {fill},
    journal,
    logger,
    address: ADDRESS,
    accountIndex: 0,
  });
  return {service, getPositions, getAccount, placeOrder, fill, journal};
}

describe('PerpsShortService.positions', () => {
  it('normalizes the marketId-keyed object form', async () => {
    const {service} = makeService({positions: {'28': makePosition()}});

    const positions = await service.positions();

    expect(positions).toHaveLength(1);
    expect(positions[0]!.marketDisplayName).toBe('NVDA-USD');
  });

  it('accepts the array form unchanged', async () => {
    const {service} = makeService({positions: [makePosition()]});

    expect(await service.positions()).toHaveLength(1);
  });
});

describe('PerpsShortService.assertNoExistingPosition', () => {
  it('passes when the market is untouched', async () => {
    const {service} = makeService();

    await expect(
      service.assertNoExistingPosition(SPEC),
    ).resolves.toBeUndefined();
  });

  it('refuses when the operator is already long the market', async () => {
    const {service} = makeService({
      positions: [makePosition({side: 'LONG', size: '94.35'})],
    });

    const error = await service
      .assertNoExistingPosition(SPEC)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PerpsPositionConflictError);
    expect((error as PerpsPositionConflictError).existingSide).toBe('LONG');
  });

  it('refuses even when the existing position is a short', async () => {
    // Adding to a short the bot did not open makes the two inseparable.
    const {service} = makeService({positions: [makePosition()]});

    await expect(service.assertNoExistingPosition(SPEC)).rejects.toThrow(
      PerpsPositionConflictError,
    );
  });

  it('ignores positions in other markets', async () => {
    const {service} = makeService({
      positions: [makePosition({marketDisplayName: 'SPCX-USD', marketId: 38})],
    });

    await expect(
      service.assertNoExistingPosition(SPEC),
    ).resolves.toBeUndefined();
  });
});

describe('PerpsShortService.assertSufficientCollateral', () => {
  it('passes when free collateral covers the requirement', async () => {
    const {service} = makeService({freeCollateral: '1000'});

    // 0.5 * 224 = 112 notional, 10% off-hours margin = 11.2, 2x = 22.4.
    await expect(
      service.assertSufficientCollateral(SPEC, '0.5', '224', 2),
    ).resolves.toBeUndefined();
  });

  it('uses the stricter off-hours margin fraction', async () => {
    // 112 notional needs 5.6 at the 5% regular-hours fraction but 11.2 at the
    // 10% off-hours one. 8 would pass the lax check and must fail the strict
    // one, or sizing before the close would break after it.
    const {service} = makeService({freeCollateral: '8'});

    await expect(
      service.assertSufficientCollateral(SPEC, '0.5', '224', 1),
    ).rejects.toThrow(PerpsMarginError);
  });

  it('refuses when collateral falls short of the headroom', async () => {
    const {service} = makeService({freeCollateral: '12'});

    const error = await service
      .assertSufficientCollateral(SPEC, '0.5', '224', 2)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PerpsMarginError);
    expect((error as Error).message).toContain('22.4');
  });
});

describe('PerpsShortService.openShort / closeShort', () => {
  it('opens as a maker sell that is not reduce-only', async () => {
    const {service, fill} = makeService();

    await service.openShort({
      tradeId: 't1',
      symbol: 'NVDA',
      spec: SPEC,
      quantity: '0.5',
      repriceSeconds: 3,
      maxAttempts: 3,
    });

    expect(fill).toHaveBeenCalledWith(
      expect.objectContaining({side: 'SELL', targetQuantity: '0.5'}),
    );
    expect(fill.mock.calls[0]![0].reduceOnly).toBeUndefined();
  });

  it('forwards improveTicks to the executor on open', async () => {
    const {service, fill} = makeService();

    await service.openShort({
      tradeId: 't1',
      symbol: 'NVDA',
      spec: SPEC,
      quantity: '0.5',
      repriceSeconds: 3,
      maxAttempts: 3,
      improveTicks: 1,
    });

    expect(fill.mock.calls[0]![0].improveTicks).toBe(1);
  });

  it('forwards improveTicks to the executor on close', async () => {
    const {service, fill} = makeService();

    await service.closeShort({
      tradeId: 't1',
      symbol: 'NVDA',
      spec: SPEC,
      quantity: '0.5',
      repriceSeconds: 3,
      maxAttempts: 3,
      improveTicks: 2,
    });

    expect(fill.mock.calls[0]![0].improveTicks).toBe(2);
  });

  it('closes as a reduce-only maker buy, so it cannot flip to a long', async () => {
    const {service, fill} = makeService();

    await service.closeShort({
      tradeId: 't1',
      symbol: 'NVDA',
      spec: SPEC,
      quantity: '0.5',
      repriceSeconds: 3,
      maxAttempts: 3,
    });

    expect(fill).toHaveBeenCalledWith(
      expect.objectContaining({side: 'BUY', reduceOnly: true}),
    );
  });
});

describe('PerpsShortService.unwindShort', () => {
  it('crosses with a reduce-only IOC bounded above the mark', async () => {
    const {service, placeOrder} = makeService();

    await service.unwindShort('t1', 'NVDA', SPEC, '0.5', '224.38', 50);

    const call = placeOrder.mock.calls[0]![0];
    expect(call).toMatchObject({
      side: 'BUY',
      timeInForce: 'IOC',
      reduceOnly: true,
    });
    // 224.38 * 1.005 = 225.5019, rounded up to the 0.01 tick.
    expect(call.amounts.price).toBe('225.51');
  });

  it('journals the unwind as a taker fill', async () => {
    const journal = memoryJournal();
    const {service} = makeService({journal});

    await service.unwindShort('t1', 'NVDA', SPEC, '0.5', '224.38', 50);

    expect(journal.events[0] as PerpFillEvent).toMatchObject({
      kind: 'perp-fill',
      side: 'BUY',
      timeInForce: 'IOC',
      reduceOnly: true,
      maker: false,
      filledQuantity: '0.5',
    });
  });
});

describe('signedSize', () => {
  it('reports a short as negative and a long as positive', () => {
    expect(signedSize(makePosition({side: 'SHORT', size: '-0.5'}))).toBe(
      '-0.5',
    );
    expect(signedSize(makePosition({side: 'LONG', size: '0.5'}))).toBe('0.5');
  });

  it('normalizes a short reported without a sign', () => {
    expect(signedSize(makePosition({side: 'SHORT', size: '0.5'}))).toBe('-0.5');
  });
});

describe('isManagedPair', () => {
  it('claims a short whose spot balance matches', () => {
    expect(isManagedPair(makePosition({size: '-0.5'}), '0.5', 50)).toBe(true);
  });

  it('tolerates drift inside the threshold', () => {
    // 0.499 vs 0.5 is 20 bps.
    expect(isManagedPair(makePosition({size: '-0.5'}), '0.499', 50)).toBe(true);
  });

  it('rejects drift beyond the threshold', () => {
    expect(isManagedPair(makePosition({size: '-0.5'}), '0.4', 50)).toBe(false);
  });

  it('never claims a long, however the spot balance looks', () => {
    expect(
      isManagedPair(makePosition({side: 'LONG', size: '94.35'}), '94.35', 50),
    ).toBe(false);
  });

  it("rejects the operator's unmatched SPCX short", () => {
    // The real case: 265.26 short against a 0.0072 dust balance.
    expect(
      isManagedPair(
        makePosition({
          marketDisplayName: 'SPCX-USD',
          side: 'SHORT',
          size: '-265.2607773',
        }),
        '0.007172884911016804',
        50,
      ),
    ).toBe(false);
  });

  it('rejects a short with no spot balance at all', () => {
    expect(isManagedPair(makePosition({size: '-0.5'}), '0', 50)).toBe(false);
  });
});
