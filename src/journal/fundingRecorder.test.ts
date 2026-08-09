import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logging/logger.js';
import type {FundingPayment} from '../perps/types.js';
import {
  createNullJournal,
  type ExecutionEvent,
  type ExecutionJournal,
  type FundingEvent,
} from './executionJournal.js';
import {FundingRecorder} from './fundingRecorder.js';

const logger = createLogger('silent');
const ADDRESS = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';
const NOW = 1_786_277_000_000;
const HOUR_MICROS = 3_600_000_000;
const BASE_MICROS = 1_786_276_800_000_000;

/** An in-memory journal so a test never writes to the operator's file. */
function memoryJournal(seed: ExecutionEvent[] = []): ExecutionJournal & {
  events: ExecutionEvent[];
} {
  const events = [...seed];
  return {
    events,
    record: (event: ExecutionEvent) => void events.push(event),
    read: () => [...events],
  };
}

function makePayment(overrides: Partial<FundingPayment> = {}): FundingPayment {
  return {
    marketId: 28,
    marketDisplayName: 'NVDA-USD',
    fundingRate: '0.0000048',
    size: '-0.5',
    payment: '0.17',
    time: BASE_MICROS,
    ...overrides,
  };
}

function makeRecorder(
  payments: FundingPayment[],
  journal: ExecutionJournal = memoryJournal(),
) {
  const getFundingPayments = vi.fn().mockResolvedValue(payments);
  const recorder = new FundingRecorder({
    client: {getFundingPayments},
    journal,
    logger,
    address: ADDRESS,
    accountIndex: 0,
    now: () => NOW,
  });
  return {recorder, getFundingPayments, journal};
}

const resolveNvda = (market: string) =>
  market === 'NVDA-USD' ? 'NVDA' : undefined;

describe('FundingRecorder.sync', () => {
  it('records a payment the journal has not seen', async () => {
    const journal = memoryJournal();
    const {recorder} = makeRecorder([makePayment()], journal);

    const result = await recorder.sync(resolveNvda);

    expect(result.recorded).toBe(1);
    expect(result.recordedTotal).toBeCloseTo(0.17, 10);
    expect(journal.read()[0]).toMatchObject({
      kind: 'funding',
      symbol: 'NVDA',
      marketId: 28,
      payment: '0.17',
      paymentTime: BASE_MICROS,
    });
  });

  it('is idempotent — a second sync double-counts nothing', async () => {
    const journal = memoryJournal();
    const payments = [makePayment()];
    const first = makeRecorder(payments, journal);
    await first.recorder.sync(resolveNvda);

    const second = makeRecorder(payments, journal);
    const result = await second.recorder.sync(resolveNvda);

    expect(result.recorded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(journal.read()).toHaveLength(1);
  });

  it('records only the payments newer than the journal cursor', async () => {
    const journal = memoryJournal();
    await makeRecorder([makePayment()], journal).recorder.sync(resolveNvda);

    const {recorder} = makeRecorder(
      [
        makePayment({time: BASE_MICROS + HOUR_MICROS, payment: '0.18'}),
        makePayment(),
      ],
      journal,
    );
    const result = await recorder.sync(resolveNvda);

    expect(result.recorded).toBe(1);
    expect(journal.read()).toHaveLength(2);
    expect((journal.read()[1] as FundingEvent).payment).toBe('0.18');
  });

  it('skips markets the strategy does not hold', async () => {
    const journal = memoryJournal();
    const {recorder} = makeRecorder(
      [
        makePayment(),
        makePayment({marketId: 38, marketDisplayName: 'SPCX-USD'}),
      ],
      journal,
    );

    const result = await recorder.sync(resolveNvda);

    expect(result.recorded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(journal.read()).toHaveLength(1);
  });

  it('writes oldest first so the journal reads chronologically', async () => {
    const journal = memoryJournal();
    // The gateway returns newest-first.
    const {recorder} = makeRecorder(
      [
        makePayment({time: BASE_MICROS + HOUR_MICROS, payment: '0.18'}),
        makePayment({time: BASE_MICROS, payment: '0.17'}),
      ],
      journal,
    );

    await recorder.sync(resolveNvda);

    expect(
      (journal.read() as FundingEvent[]).map(event => event.paymentTime),
    ).toEqual([BASE_MICROS, BASE_MICROS + HOUR_MICROS]);
  });

  it('backfills 30 days when the journal has no funding yet', async () => {
    const {recorder, getFundingPayments} = makeRecorder([]);

    await recorder.sync(resolveNvda);

    expect(getFundingPayments).toHaveBeenCalledWith({
      address: ADDRESS,
      accountIndex: 0,
      from: NOW - 30 * 86_400_000,
      to: NOW,
    });
  });

  it('resumes from the oldest market cursor once funding exists', async () => {
    const journal = memoryJournal();
    await makeRecorder(
      [makePayment({time: BASE_MICROS + HOUR_MICROS})],
      journal,
    ).recorder.sync(resolveNvda);

    const {recorder, getFundingPayments} = makeRecorder([], journal);
    await recorder.sync(resolveNvda);

    expect(getFundingPayments.mock.calls[0]![0].from).toBe(
      Math.floor((BASE_MICROS + HOUR_MICROS) / 1000),
    );
  });

  it('carries a negative payment through with its sign', async () => {
    const journal = memoryJournal();
    const {recorder} = makeRecorder([makePayment({payment: '-0.05'})], journal);

    const result = await recorder.sync(resolveNvda);

    expect(result.recordedTotal).toBeCloseTo(-0.05, 10);
  });

  it('records nothing into a null journal', async () => {
    const {recorder} = makeRecorder([makePayment()], createNullJournal());

    const result = await recorder.sync(resolveNvda);

    expect(result.recorded).toBe(1);
  });
});
