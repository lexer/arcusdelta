import {describe, expect, it, vi} from 'vitest';
import type {DepositPlan, TokenMeta} from '../uniswap/depositService.js';
import {
  buildDepositSummary,
  runDepositCommand,
  type DepositCommandDeps,
  type DepositRequestItem,
} from './depositCommand.js';

const USDG: TokenMeta = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  decimals: 6,
};

const NVDA: TokenMeta = {
  address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  symbol: 'NVDA',
  decimals: 18,
};

const AAPL: TokenMeta = {
  address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  symbol: 'AAPL',
  decimals: 18,
};

const nvdaPlan: DepositPlan = {
  pool: {
    token0: USDG.address,
    token1: NVDA.address,
    fee: 3000,
    tickSpacing: 60,
    address: '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B',
  },
  currentTick: 223440,
  tickLower: 223140,
  tickUpper: 223740,
  liquidity: 1_234_567_890n,
  stockAmount: 25_178_400_616_157_272n,
  usdgAmount: 5_000_000n,
  amount0Desired: 5_025_000n,
  amount1Desired: 25_304_292_619_238_058n,
  amount0Min: 4_975_000n,
  amount1Min: 25_052_508_611_476_486n,
  usdgBalance: 1_000_000_000n,
};

const aaplPlan: DepositPlan = {
  ...nvdaPlan,
  pool: {
    ...nvdaPlan.pool,
    token1: AAPL.address,
    address: '0x783C9bbB765047CFdD2b84b92b2Ca9F11D34b7Ed',
  },
  currentTick: 218900,
  tickLower: 218700,
  tickUpper: 219100,
};

function makeItem(
  symbol: string,
  stock: TokenMeta,
  plan: DepositPlan,
  overrides: Partial<DepositRequestItem> = {},
): DepositRequestItem & {
  planFn: ReturnType<typeof vi.fn>;
  executeFn: ReturnType<typeof vi.fn>;
} {
  const planFn = vi.fn().mockResolvedValue(plan);
  const executeFn = vi.fn().mockResolvedValue({
    hash: '0xfeed',
    tokenId: 4242n,
    gasUsed: 100n,
    plan,
    approvalHashes: [],
  });

  return {
    symbol,
    usdg: USDG,
    stock,
    rangeDeviationPercent: 3,
    depositService: {plan: planFn, execute: executeFn},
    planFn,
    executeFn,
    ...overrides,
  };
}

function deps(overrides: Partial<DepositCommandDeps> = {}): DepositCommandDeps {
  return {
    items: [makeItem('NVDA', NVDA, nvdaPlan)],
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
    ...overrides,
  };
}

describe('confirmation gate', () => {
  it('opens no position when the operator declines', async () => {
    const item = makeItem('NVDA', NVDA, nvdaPlan);
    const subject = deps({
      items: [item],
      confirm: vi.fn().mockResolvedValue(false),
    });

    const result = await runDepositCommand(subject);

    expect(result).toBeUndefined();
    expect(item.executeFn).not.toHaveBeenCalled();
  });

  it('plans every symbol before asking, so the operator sees real numbers', async () => {
    const nvda = makeItem('NVDA', NVDA, nvdaPlan);
    const aapl = makeItem('AAPL', AAPL, aaplPlan);
    const subject = deps({
      items: [nvda, aapl],
      confirm: vi.fn().mockResolvedValue(false),
    });

    await runDepositCommand(subject);

    expect(nvda.planFn).toHaveBeenCalledOnce();
    expect(aapl.planFn).toHaveBeenCalledOnce();
  });

  it('executes every symbol after one combined approval', async () => {
    const nvda = makeItem('NVDA', NVDA, nvdaPlan);
    const aapl = makeItem('AAPL', AAPL, aaplPlan);
    const confirm = vi.fn().mockResolvedValue(true);
    const subject = deps({items: [nvda, aapl], confirm});

    const outcomes = await runDepositCommand(subject);

    expect(confirm).toHaveBeenCalledOnce();
    expect(nvda.executeFn).toHaveBeenCalledWith(nvdaPlan);
    expect(aapl.executeFn).toHaveBeenCalledWith(aaplPlan);
    expect(outcomes).toHaveLength(2);
  });

  it('reports no-op when nothing is selected', async () => {
    const subject = deps({items: []});

    const outcomes = await runDepositCommand(subject);

    expect(outcomes).toEqual([]);
    expect(subject.confirm).not.toHaveBeenCalled();
  });
});

describe('partial failure', () => {
  it('skips planning symbols that fail, but still confirms and executes the rest', async () => {
    const failing = makeItem('NVDA', NVDA, nvdaPlan, {
      depositService: {
        plan: vi.fn().mockRejectedValue(new Error('no stock balance')),
        execute: vi.fn(),
      },
    });
    const ok = makeItem('AAPL', AAPL, aaplPlan);
    const confirm = vi.fn().mockResolvedValue(true);
    const subject = deps({items: [failing, ok], confirm});

    const outcomes = await runDepositCommand(subject);

    expect(confirm).toHaveBeenCalledOnce();
    expect(ok.executeFn).toHaveBeenCalledWith(aaplPlan);
    expect(outcomes).toContainEqual(
      expect.objectContaining({symbol: 'NVDA', error: 'no stock balance'}),
    );
    expect(outcomes).toContainEqual(expect.objectContaining({symbol: 'AAPL'}));
  });

  it('never confirms when every symbol fails to plan', async () => {
    const failing = makeItem('NVDA', NVDA, nvdaPlan, {
      depositService: {
        plan: vi.fn().mockRejectedValue(new Error('no stock balance')),
        execute: vi.fn(),
      },
    });
    const confirm = vi.fn();
    const subject = deps({items: [failing], confirm});

    const outcomes = await runDepositCommand(subject);

    expect(confirm).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{symbol: 'NVDA', error: 'no stock balance'}]);
  });

  it('continues past one execution failure and reports both outcomes', async () => {
    const failing = makeItem('NVDA', NVDA, nvdaPlan, {
      depositService: {
        plan: vi.fn().mockResolvedValue(nvdaPlan),
        execute: vi.fn().mockRejectedValue(new Error('mint reverted: STF')),
      },
    });
    const ok = makeItem('AAPL', AAPL, aaplPlan);
    const subject = deps({items: [failing, ok]});

    const outcomes = await runDepositCommand(subject);

    expect(outcomes).toContainEqual(
      expect.objectContaining({symbol: 'NVDA', error: 'mint reverted: STF'}),
    );
    expect(outcomes).toContainEqual(expect.objectContaining({symbol: 'AAPL'}));
  });
});

describe('buildDepositSummary', () => {
  it('states every symbols deposit legs and range', () => {
    const summary = buildDepositSummary([
      {item: makeItem('NVDA', NVDA, nvdaPlan), plan: nvdaPlan},
      {item: makeItem('AAPL', AAPL, aaplPlan), plan: aaplPlan},
    ]);

    expect(summary).toContain('NVDA');
    expect(summary).toContain('0.025178400616157272 NVDA');
    expect(summary).toContain('AAPL');
    expect(summary).toContain('223140');
    expect(summary).toContain('223740');
    expect(summary).toContain('±3%');
    expect(summary).toContain('PRODUCTION');
  });

  it('shows a price band that brackets each pools price', () => {
    const summary = buildDepositSummary([
      {item: makeItem('NVDA', NVDA, nvdaPlan), plan: nvdaPlan},
    ]);

    // ~198 USDG per NVDA at tick 223440, +/-3%.
    expect(summary).toMatch(/19[0-9]\.\d{4} USDG per NVDA/);
  });

  it('discloses the maximum each may pull', () => {
    const summary = buildDepositSummary([
      {item: makeItem('NVDA', NVDA, nvdaPlan), plan: nvdaPlan},
    ]);

    expect(summary).toContain('max pull');
    expect(summary).toContain('5.025 USDG');
  });

  it('pluralizes correctly for a single position', () => {
    const summary = buildDepositSummary([
      {item: makeItem('NVDA', NVDA, nvdaPlan), plan: nvdaPlan},
    ]);

    expect(summary).toContain('1 Uniswap v3 liquidity position');
    expect(summary).not.toContain('1 Uniswap v3 liquidity positions');
  });
});
