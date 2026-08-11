import {describe, expect, it, vi} from 'vitest';
import type {
  ExecutionEvent,
  ExecutionJournal,
} from '../journal/executionJournal.js';
import {createLogger} from '../logging/logger.js';
import type {PerpPosition} from '../perps/types.js';
import {
  costBasisIsPlausible,
  PairMonitor,
  spotCostFromJournal,
} from './pairMonitor.js';
import type {WatchedPair} from './pairMonitor.js';

const logger = createLogger('silent');

function memoryJournal(events: ExecutionEvent[] = []): ExecutionJournal {
  return {record: () => {}, read: () => [...events]};
}

function spotBuy(symbol: string, usdg: string, base: string): ExecutionEvent {
  return {
    kind: 'spot-fill',
    at: '2026-08-09T17:49:00.000Z',
    tradeId: 't1',
    symbol,
    direction: 'buy',
    sellSymbol: 'USDG',
    buySymbol: symbol,
    sellAmount: usdg,
    buyAmount: base,
    txHashes: ['0xabc'],
  };
}

function spotSell(symbol: string, base: string, usdg: string): ExecutionEvent {
  return {
    kind: 'spot-fill',
    at: '2026-08-09T18:49:00.000Z',
    tradeId: 't1',
    symbol,
    direction: 'sell',
    sellSymbol: symbol,
    buySymbol: 'USDG',
    sellAmount: base,
    buyAmount: usdg,
    txHashes: ['0xdef'],
  };
}

function makePosition(overrides: Partial<PerpPosition> = {}): PerpPosition {
  return {
    address: '0xabc',
    accountIndex: 0,
    marketId: 28,
    marketDisplayName: 'NVDA-USD',
    side: 'SHORT',
    size: '-0.053',
    averageEntryPrice: '225.18',
    cumulativeFunding: {sinceOpen: '0.000057278'},
    leverage: '1',
    marginMode: 'CROSS',
    marginUsed: '0.6',
    positionValueNotional: '-11.93',
    unrealizedPnl: '0',
    markPx: '225.18',
    ...overrides,
  };
}

function makePair(overrides: Partial<WatchedPair> = {}): WatchedPair {
  return {
    symbol: 'NVDA',
    market: 'NVDA-USD',
    readSpotBalance: async () => '0.052945920766603108',
    quoteSpotExit: async () => '11.93',
    quotePerpExit: async () => '225.18',
    ...overrides,
  };
}

function makeMonitor(
  overrides: {
    pairs?: WatchedPair[];
    positions?: PerpPosition[];
    journal?: ExecutionJournal;
    minProfitBps?: number;
    deltaToleranceBps?: number;
  } = {},
) {
  return new PairMonitor({
    pairs: overrides.pairs ?? [makePair()],
    shorts: {
      positions: vi
        .fn()
        .mockResolvedValue(overrides.positions ?? [makePosition()]),
    },
    marketData: {getBbo: vi.fn()},
    journal:
      overrides.journal ??
      memoryJournal([spotBuy('NVDA', '11.93454', '0.0529')]),
    logger,
    minProfitBps: overrides.minProfitBps ?? 0,
    deltaToleranceBps: overrides.deltaToleranceBps ?? 100,
    checkIntervalSeconds: 30,
    sleep: async () => {},
  });
}

describe('spotCostFromJournal', () => {
  it('sums the USDG spent on buys', () => {
    const journal = memoryJournal([
      spotBuy('NVDA', '11.93454', '0.0529'),
      spotBuy('NVDA', '5', '0.022'),
    ]);

    expect(spotCostFromJournal(journal, 'NVDA')).toBe('16.93454');
  });

  it('nets out USDG returned by earlier sells', () => {
    const journal = memoryJournal([
      spotBuy('NVDA', '20', '0.09'),
      spotSell('NVDA', '0.04', '9'),
    ]);

    expect(spotCostFromJournal(journal, 'NVDA')).toBe('11');
  });

  it('ignores other symbols', () => {
    const journal = memoryJournal([
      spotBuy('NVDA', '11', '0.05'),
      spotBuy('AAPL', '99', '0.3'),
    ]);

    expect(spotCostFromJournal(journal, 'NVDA')).toBe('11');
  });

  it('is zero with no history', () => {
    expect(spotCostFromJournal(memoryJournal(), 'NVDA')).toBe('0');
  });
});

describe('PairMonitor.check', () => {
  it('values a managed pair', async () => {
    const {opportunities} = await makeMonitor().check();

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]!.symbol).toBe('NVDA');
    expect(opportunities[0]!.quantity).toBe('0.053');
  });

  it('takes the perp entry price from the exchange, not the journal', async () => {
    const {opportunities} = await makeMonitor({
      positions: [makePosition({averageEntryPrice: '230'})],
    }).check();

    expect(opportunities[0]!.entryBasis).not.toBe('0');
    // 230 entry vs a 225.18 exit is 4.82 per unit of profit on the short.
    expect(opportunities[0]!.perpPnl).toBe('0.25546');
  });

  it('flags a pair once the basis has converged enough', async () => {
    // Perp buy-back 1.18 cheaper than entry on 0.053 is +0.06254, less
    // 0.00454 of spot exit cost plus funding: ~48.6 bps on 11.93 deployed.
    const {opportunities} = await makeMonitor({
      pairs: [makePair({quotePerpExit: async () => '224.00'})],
      minProfitBps: 40,
    }).check();

    expect(Number(opportunities[0]!.netPnlBps)).toBeCloseTo(48.6, 1);
    expect(opportunities[0]!.worthClosing).toBe(true);
  });

  it('holds a pair that has not converged', async () => {
    const {opportunities} = await makeMonitor({minProfitBps: 50}).check();

    expect(opportunities[0]!.worthClosing).toBe(false);
  });

  it('skips a long position outright', async () => {
    const {opportunities, foreign} = await makeMonitor({
      positions: [makePosition({side: 'LONG', size: '94.35'})],
    }).check();

    expect(opportunities).toHaveLength(0);
    expect(foreign).toEqual(['NVDA-USD']);
  });

  it("skips a short with no matching spot balance — the operator's own", async () => {
    const {opportunities, foreign} = await makeMonitor({
      pairs: [makePair({readSpotBalance: async () => '0.0072'})],
      positions: [makePosition({size: '-265.26'})],
    }).check();

    expect(opportunities).toHaveLength(0);
    expect(foreign).toEqual(['NVDA-USD']);
  });

  it('ignores a watched symbol with no open position', async () => {
    const {opportunities} = await makeMonitor({positions: []}).check();

    expect(opportunities).toHaveLength(0);
  });

  it('counts funding accrued since the pair opened', async () => {
    const {opportunities} = await makeMonitor({
      positions: [makePosition({cumulativeFunding: {sinceOpen: '0.5'}})],
    }).check();

    expect(opportunities[0]!.fundingEarned).toBe('0.5');
  });

  it('falls back to all-time funding when sinceOpen is absent', async () => {
    const {opportunities} = await makeMonitor({
      positions: [makePosition({cumulativeFunding: {allTime: '0.25'}})],
    }).check();

    expect(opportunities[0]!.fundingEarned).toBe('0.25');
  });

  it('charges the real exit quote rather than the mark', async () => {
    const generous = await makeMonitor({
      pairs: [makePair({quoteSpotExit: async () => '12.20'})],
    }).check();
    const realistic = await makeMonitor({
      pairs: [makePair({quoteSpotExit: async () => '11.80'})],
    }).check();

    expect(Number(generous.opportunities[0]!.netPnl)).toBeGreaterThan(
      Number(realistic.opportunities[0]!.netPnl),
    );
  });
});

describe('costBasisIsPlausible', () => {
  it('accepts a cost basis near the position notional', () => {
    expect(costBasisIsPlausible('5012', '5020')).toBe(true);
  });

  it('tolerates the drift a real price move produces', () => {
    expect(costBasisIsPlausible('5000', '4000')).toBe(true);
    expect(costBasisIsPlausible('5000', '7000')).toBe(true);
  });

  it('rejects a cost basis orders of magnitude off', () => {
    // The real failure: $12 recorded against a $5,020 position.
    expect(costBasisIsPlausible('11.93454', '5020')).toBe(false);
  });

  it('rejects a missing cost basis rather than reading it as free', () => {
    expect(costBasisIsPlausible('0', '5020')).toBe(false);
  });
});

describe('PairMonitor cost-basis guard', () => {
  it('refuses to value a pair whose journal is missing fills', async () => {
    const {opportunities, failed} = await makeMonitor({
      // 23 NVDA at 225 is ~5,175 of position against 11.93 recorded.
      positions: [makePosition({size: '-23', markPx: '225'})],
      pairs: [makePair({readSpotBalance: async () => '23'})],
      journal: memoryJournal([spotBuy('NVDA', '11.93454', '0.0529')]),
    }).check();

    expect(opportunities).toHaveLength(0);
    expect(failed[0]!.error).toContain('implausible');
    expect(failed[0]!.error).toContain('missing fills');
  });

  it('emits no CLOSE signal from an unusable cost basis', async () => {
    const lines: string[] = [];
    await makeMonitor({
      positions: [makePosition({size: '-23', markPx: '225'})],
      pairs: [makePair({readSpotBalance: async () => '23'})],
      journal: memoryJournal([spotBuy('NVDA', '11.93454', '0.0529')]),
      minProfitBps: 5,
    }).run({maxPasses: 1, print: l => void lines.push(l)});

    expect(lines.join('\n')).not.toContain('CLOSE');
    expect(lines.join('\n')).not.toContain('above threshold');
  });

  it('values normally once the journal reflects the real cost', async () => {
    const {opportunities, failed} = await makeMonitor({
      positions: [makePosition({size: '-23', markPx: '225'})],
      pairs: [
        makePair({
          readSpotBalance: async () => '23',
          quoteSpotExit: async () => '5150',
        }),
      ],
      journal: memoryJournal([spotBuy('NVDA', '5175', '23')]),
    }).check();

    expect(failed).toHaveLength(0);
    expect(opportunities).toHaveLength(1);
  });
});

describe('PairMonitor funding sync', () => {
  it('records newly settled funding before valuing', async () => {
    const sync = vi.fn().mockResolvedValue({
      recorded: 1,
      skipped: 0,
      recordedTotal: 0.0001,
    });
    const monitor = new PairMonitor({
      pairs: [makePair()],
      shorts: {positions: vi.fn().mockResolvedValue([makePosition()])},
      marketData: {getBbo: vi.fn()},
      journal: memoryJournal([spotBuy('NVDA', '11.93454', '0.0529')]),
      logger,
      minProfitBps: 0,
      deltaToleranceBps: 100,
      checkIntervalSeconds: 30,
      funding: {sync},
      sleep: async () => {},
    });

    await monitor.check();

    expect(sync).toHaveBeenCalledTimes(1);
    const resolve = sync.mock.calls[0]![0] as (m: string) => string | undefined;
    expect(resolve('NVDA-USD')).toBe('NVDA');
    expect(resolve('SPCX-USD')).toBeUndefined();
  });

  it('never records funding for a short the strategy does not own', async () => {
    const sync = vi
      .fn()
      .mockResolvedValue({recorded: 0, skipped: 0, recordedTotal: 0});
    const monitor = new PairMonitor({
      // Watched as a candidate, but the spot balance does not match: this is
      // the operator's own short, and its funding is not this bot's carry.
      pairs: [makePair({readSpotBalance: async () => '0.0072'})],
      shorts: {
        positions: vi.fn().mockResolvedValue([makePosition({size: '-265.26'})]),
      },
      marketData: {getBbo: vi.fn()},
      journal: memoryJournal(),
      logger,
      minProfitBps: 0,
      deltaToleranceBps: 100,
      checkIntervalSeconds: 30,
      funding: {sync},
      sleep: async () => {},
    });

    const {foreign} = await monitor.check();

    expect(foreign).toEqual(['NVDA-USD']);
    expect(sync).not.toHaveBeenCalled();
  });

  it('keeps valuing when the funding sync fails', async () => {
    const monitor = new PairMonitor({
      pairs: [makePair()],
      shorts: {positions: vi.fn().mockResolvedValue([makePosition()])},
      marketData: {getBbo: vi.fn()},
      journal: memoryJournal([spotBuy('NVDA', '11.93454', '0.0529')]),
      logger,
      minProfitBps: 0,
      deltaToleranceBps: 100,
      checkIntervalSeconds: 30,
      funding: {sync: vi.fn().mockRejectedValue(new Error('rate limited'))},
      sleep: async () => {},
    });

    const {opportunities} = await monitor.check();

    expect(opportunities).toHaveLength(1);
  });
});

describe('PairMonitor resilience', () => {
  const outage = () => {
    throw new Error('Arcus router returned no quote for this pair');
  };

  it('reports a pair it could not value instead of throwing', async () => {
    const {opportunities, failed} = await makeMonitor({
      pairs: [makePair({quoteSpotExit: outage})],
    }).check();

    expect(opportunities).toHaveLength(0);
    expect(failed).toEqual([
      {market: 'NVDA-USD', error: expect.stringContaining('no quote')},
    ]);
  });

  it('keeps valuing the other pairs when one venue is down', async () => {
    const {opportunities, failed} = await makeMonitor({
      pairs: [
        makePair({symbol: 'AAPL', market: 'AAPL-USD', quoteSpotExit: outage}),
        makePair(),
      ],
      positions: [
        makePosition({marketDisplayName: 'AAPL-USD', marketId: 29}),
        makePosition(),
      ],
    }).check();

    expect(failed.map(f => f.market)).toEqual(['AAPL-USD']);
    expect(opportunities.map(o => o.symbol)).toEqual(['NVDA']);
  });

  it('still records funding for a pair whose valuation failed', async () => {
    const sync = vi
      .fn()
      .mockResolvedValue({recorded: 0, skipped: 0, recordedTotal: 0});
    const monitor = new PairMonitor({
      pairs: [makePair({quoteSpotExit: outage})],
      shorts: {positions: vi.fn().mockResolvedValue([makePosition()])},
      marketData: {getBbo: vi.fn()},
      journal: memoryJournal(),
      logger,
      minProfitBps: 0,
      deltaToleranceBps: 100,
      checkIntervalSeconds: 30,
      funding: {sync},
      sleep: async () => {},
    });

    await monitor.check();

    // Ownership does not depend on a quote succeeding.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('survives a whole pass failing and carries on', async () => {
    const positions = vi
      .fn()
      .mockRejectedValueOnce(new Error('gateway 503'))
      .mockResolvedValue([makePosition()]);
    const monitor = new PairMonitor({
      pairs: [makePair()],
      shorts: {positions},
      marketData: {getBbo: vi.fn()},
      journal: memoryJournal([spotBuy('NVDA', '11.93454', '0.0529')]),
      logger,
      minProfitBps: 0,
      deltaToleranceBps: 100,
      checkIntervalSeconds: 30,
      sleep: async () => {},
    });
    const lines: string[] = [];

    await monitor.run({maxPasses: 2, print: l => void lines.push(l)});

    const output = lines.join('\n');
    expect(output).toContain('pass failed: gateway 503');
    expect(output).toContain('pass 2');
    expect(output).toContain('NVDA');
  });

  it('gives up after a sustained run of failures rather than looping silently', async () => {
    const monitor = new PairMonitor({
      pairs: [makePair()],
      shorts: {positions: vi.fn().mockRejectedValue(new Error('gateway 503'))},
      marketData: {getBbo: vi.fn()},
      journal: memoryJournal(),
      logger,
      minProfitBps: 0,
      deltaToleranceBps: 100,
      checkIntervalSeconds: 30,
      sleep: async () => {},
    });
    const lines: string[] = [];

    await monitor.run({maxPasses: 50, print: l => void lines.push(l)});

    const output = lines.join('\n');
    expect(output).toContain('10 passes in a row have failed');
    expect(output).toContain('Open positions are untouched');
    expect(output).not.toContain('pass 11');
  });
});

describe('PairMonitor.run', () => {
  it('prints a table each pass and stops after maxPasses', async () => {
    const lines: string[] = [];
    await makeMonitor().run({maxPasses: 2, print: l => void lines.push(l)});

    const output = lines.join('\n');
    expect(output).toContain('pass 1');
    expect(output).toContain('pass 2');
    expect(output).toContain('NVDA');
  });

  it('says so when nothing is open', async () => {
    const lines: string[] = [];
    await makeMonitor({positions: []}).run({
      maxPasses: 1,
      print: l => void lines.push(l),
    });

    expect(lines.join('\n')).toContain('no managed pairs open');
  });

  it('calls out a pair above the threshold without closing it', async () => {
    const lines: string[] = [];
    await makeMonitor({
      pairs: [makePair({quotePerpExit: async () => '224.00'})],
      minProfitBps: 10,
    }).run({maxPasses: 1, print: l => void lines.push(l)});

    const output = lines.join('\n');
    expect(output).toContain('above threshold');
  });
});
