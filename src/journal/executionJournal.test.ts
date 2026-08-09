import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  createFileJournal,
  createNullJournal,
  latestFundingTimeByMarket,
  totalFunding,
  type ExecutionEvent,
  type FundingEvent,
  type PerpFillEvent,
} from './executionJournal.js';

function tempJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'journal-')), 'nested', 'exec.jsonl');
}

function makePerpFill(overrides: Partial<PerpFillEvent> = {}): PerpFillEvent {
  return {
    kind: 'perp-fill',
    at: '2026-08-09T05:00:00.000Z',
    tradeId: 'trade-1',
    symbol: 'NVDA',
    market: 'NVDA-USD',
    marketId: 28,
    side: 'SELL',
    orderId: 'ord-1',
    filledQuantity: '0.5',
    requestedQuantity: '0.5',
    limitPrice: '224.38',
    averageFillPrice: '224.38',
    timeInForce: 'ALO',
    reduceOnly: false,
    maker: true,
    ...overrides,
  };
}

function makeFunding(
  marketId: number,
  paymentTime: number,
  payment: string,
  symbol = 'NVDA',
): FundingEvent {
  return {
    kind: 'funding',
    at: '2026-08-09T05:00:00.000Z',
    symbol,
    market: `${symbol}-USD`,
    marketId,
    fundingRate: '0.0000048',
    size: '-0.5',
    payment,
    paymentTime,
  };
}

describe('createFileJournal', () => {
  it('creates the parent directory on first write', () => {
    const path = tempJournalPath();
    createFileJournal(path).record(makePerpFill());

    expect(readFileSync(path, 'utf8')).toContain('perp-fill');
  });

  it('writes one JSON object per line', () => {
    const path = tempJournalPath();
    const journal = createFileJournal(path);

    journal.record(makePerpFill({orderId: 'ord-1'}));
    journal.record(makePerpFill({orderId: 'ord-2'}));

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).orderId).toBe('ord-2');
  });

  it('appends rather than replacing across separate handles', () => {
    const path = tempJournalPath();
    createFileJournal(path).record(makePerpFill({orderId: 'ord-1'}));
    createFileJournal(path).record(makePerpFill({orderId: 'ord-2'}));

    expect(createFileJournal(path).read()).toHaveLength(2);
  });

  it('reads events back oldest first', () => {
    const path = tempJournalPath();
    const journal = createFileJournal(path);
    journal.record(makePerpFill({orderId: 'first'}));
    journal.record(makePerpFill({orderId: 'second'}));

    const events = journal.read() as PerpFillEvent[];
    expect(events.map(e => e.orderId)).toEqual(['first', 'second']);
  });

  it('reads as empty when nothing has been executed yet', () => {
    expect(createFileJournal(tempJournalPath()).read()).toEqual([]);
  });

  it('survives a torn final line from a crash mid-append', () => {
    const path = tempJournalPath();
    const journal = createFileJournal(path);
    journal.record(makePerpFill({orderId: 'good'}));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind":"perp-f`, 'utf8');

    const events = journal.read() as PerpFillEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.orderId).toBe('good');
  });
});

describe('createNullJournal', () => {
  it('records nothing, so a dry run leaves no entries that read as real', () => {
    const journal = createNullJournal();
    journal.record(makePerpFill());

    expect(journal.read()).toEqual([]);
  });
});

describe('totalFunding', () => {
  it('nets received against paid', () => {
    const events: ExecutionEvent[] = [
      makeFunding(28, 1, '0.17'),
      makeFunding(28, 2, '-0.05'),
    ];

    expect(totalFunding(events)).toBeCloseTo(0.12, 10);
  });

  it('can be scoped to one symbol', () => {
    const events: ExecutionEvent[] = [
      makeFunding(28, 1, '0.17', 'NVDA'),
      makeFunding(38, 1, '1.00', 'SPCX'),
    ];

    expect(totalFunding(events, 'NVDA')).toBeCloseTo(0.17, 10);
  });

  it('ignores non-funding events', () => {
    expect(totalFunding([makePerpFill()])).toBe(0);
  });

  it('is zero on an empty journal', () => {
    expect(totalFunding([])).toBe(0);
  });
});

describe('latestFundingTimeByMarket', () => {
  it('tracks the newest payment time per market', () => {
    const latest = latestFundingTimeByMarket([
      makeFunding(28, 100, '0.1'),
      makeFunding(28, 300, '0.1'),
      makeFunding(28, 200, '0.1'),
      makeFunding(38, 50, '0.1'),
    ]);

    expect(latest.get(28)).toBe(300);
    expect(latest.get(38)).toBe(50);
  });

  it('is empty when no funding has been recorded', () => {
    expect(latestFundingTimeByMarket([makePerpFill()]).size).toBe(0);
  });
});
