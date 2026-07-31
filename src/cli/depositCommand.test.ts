import {describe, expect, it, vi} from 'vitest';
import type {DepositPlan, TokenMeta} from '../uniswap/depositService.js';
import {
  buildDepositSummary,
  runDepositCommand,
  type DepositCommandDeps,
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

const plan: DepositPlan = {
  poolKey: {
    currency0: USDG.address,
    currency1: NVDA.address,
    fee: 3000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000',
  },
  poolId: `0x${'3b'.repeat(32)}`,
  currentTick: 223440,
  tickLower: 223140,
  tickUpper: 223740,
  liquidity: 1_234_567_890n,
  stockAmount: 25_178_400_616_157_272n,
  usdgAmount: 5_000_000n,
  amount0Max: 5_025_000n,
  amount1Max: 25_304_292_619_238_058n,
  usdgBalance: 1_000_000_000n,
};

function deps(
  overrides: Partial<DepositCommandDeps> = {},
): DepositCommandDeps & {
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
    usdg: USDG,
    stock: NVDA,
    rangeDeviationPercent: 3,
    depositService: {plan: planFn, execute: executeFn},
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
    planFn,
    executeFn,
    ...overrides,
  };
}

describe('confirmation gate', () => {
  it('opens no position when the operator declines', async () => {
    const subject = deps({confirm: vi.fn().mockResolvedValue(false)});

    const result = await runDepositCommand(subject);

    expect(result).toBeUndefined();
    expect(subject.executeFn).not.toHaveBeenCalled();
  });

  it('plans before asking, so the operator sees real numbers', async () => {
    const subject = deps({confirm: vi.fn().mockResolvedValue(false)});

    await runDepositCommand(subject);

    expect(subject.planFn).toHaveBeenCalledOnce();
  });

  it('executes the very plan that was shown', async () => {
    const subject = deps();

    const result = await runDepositCommand(subject);

    expect(subject.executeFn).toHaveBeenCalledWith(plan);
    expect(result?.hash).toBe('0xfeed');
  });
});

describe('buildDepositSummary', () => {
  it('states both deposit legs and the range', () => {
    const summary = buildDepositSummary(plan, deps());

    expect(summary).toContain('0.025178400616157272 NVDA');
    expect(summary).toContain('5 USDG');
    expect(summary).toContain('223140');
    expect(summary).toContain('223740');
    expect(summary).toContain('±3%');
    expect(summary).toContain('PRODUCTION');
  });

  it('shows a price band that brackets the pool price', () => {
    const summary = buildDepositSummary(plan, deps());

    // ~198 USDG per NVDA at tick 223440, +/-3%.
    expect(summary).toMatch(/19[0-9]\.\d{4} USDG per NVDA/);
  });

  it('discloses the maximum it may pull', () => {
    const summary = buildDepositSummary(plan, deps());

    expect(summary).toContain('max pull');
    expect(summary).toContain('5.025 USDG');
  });
});
