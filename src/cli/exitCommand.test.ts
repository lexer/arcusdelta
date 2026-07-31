import {describe, expect, it, vi} from 'vitest';
import type {TokenMeta} from '../uniswap/depositService.js';
import type {ExitPlan} from '../uniswap/positionExitService.js';
import type {OwnedPosition} from '../uniswap/positionReader.js';
import {
  buildExitSummary,
  runExitCommand,
  type ExitCommandDeps,
} from './exitCommand.js';

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

const POSITION: OwnedPosition = {
  tokenId: 422596n,
  tickLower: 223080,
  tickUpper: 223740,
  liquidity: 60_210_398_382_745n,
};

const PLAN: ExitPlan = {
  position: POSITION,
  principalUsdg: 12_288_029n,
  principalStock: 77_971_818_932_109_303n,
  fees0: 13_002n,
  fees1: 72_064_323_237_819n,
  amount0Min: 12_165_148n,
  amount1Min: 77_192_100_742_788_210n,
};

function deps(overrides: Partial<ExitCommandDeps> = {}): ExitCommandDeps & {
  planFn: ReturnType<typeof vi.fn>;
  exitFn: ReturnType<typeof vi.fn>;
} {
  const planFn = vi.fn().mockResolvedValue(PLAN);
  const exitFn = vi.fn().mockResolvedValue({
    tokenId: 422596n,
    closeHash: '0xc105e',
    stockSold: 77_971_818_932_109_303n,
    saleTxHash: '0x5e11',
    usdgReceived: '15400000',
  });

  return {
    usdg: USDG,
    stock: NVDA,
    positions: [POSITION],
    sqrtPriceX96: 5_630_988_710_377_423_664_134_631_725_262_565n,
    exitService: {plan: planFn, exit: exitFn},
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
    dryRun: false,
    planFn,
    exitFn,
    ...overrides,
  };
}

describe('confirmation gate', () => {
  it('withdraws nothing when the operator declines', async () => {
    const subject = deps({confirm: vi.fn().mockResolvedValue(false)});

    const result = await runExitCommand(subject);

    expect(result).toBeUndefined();
    expect(subject.exitFn).not.toHaveBeenCalled();
  });

  it('plans before asking, so real numbers are shown', async () => {
    const subject = deps({confirm: vi.fn().mockResolvedValue(false)});

    await runExitCommand(subject);

    expect(subject.planFn).toHaveBeenCalledOnce();
  });

  it('exits the very plan that was shown', async () => {
    const subject = deps();

    const results = await runExitCommand(subject);

    expect(subject.exitFn).toHaveBeenCalledWith(PLAN);
    expect(results?.[0]?.closeHash).toBe('0xc105e');
  });
});

describe('dry run', () => {
  it('never withdraws, and never even asks', async () => {
    const confirm = vi.fn();
    const subject = deps({dryRun: true, confirm});

    const result = await runExitCommand(subject);

    expect(result).toBeUndefined();
    expect(subject.exitFn).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('still reports what would happen', async () => {
    const print = vi.fn();
    const subject = deps({dryRun: true, print});

    await runExitCommand(subject);

    expect(print).toHaveBeenCalled();
    const printed = print.mock.calls.map(call => call[0]).join('\n');
    expect(printed).toContain('422596');
    expect(printed).toContain('Dry run');
  });
});

describe('no positions', () => {
  it('returns cleanly without asking anything', async () => {
    const confirm = vi.fn();
    const subject = deps({positions: [], confirm});

    const result = await runExitCommand(subject);

    expect(result).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(subject.planFn).not.toHaveBeenCalled();
  });
});

describe('buildExitSummary', () => {
  it('states principal, fees, and the guaranteed minimums', () => {
    const summary = buildExitSummary([PLAN], deps());

    expect(summary).toContain('12.288029 USDG');
    expect(summary).toContain('0.077971818932109303 NVDA');
    expect(summary).toContain('0.013002 USDG');
    expect(summary).toContain('at least');
    expect(summary).toContain('12.165148 USDG');
  });

  it('says the fees are claimed and the stock is sold', () => {
    const summary = buildExitSummary([PLAN], deps());

    expect(summary).toContain('claim fees');
    expect(summary).toContain('Arcus');
    expect(summary).toContain('PRODUCTION');
  });

  it('pluralizes correctly for a single position', () => {
    expect(buildExitSummary([PLAN], deps())).toContain('1 liquidity position,');
  });
});

describe('multiple positions', () => {
  it('exits each one', async () => {
    const second = {...POSITION, tokenId: 999n};
    const subject = deps({positions: [POSITION, second]});

    const results = await runExitCommand(subject);

    expect(subject.planFn).toHaveBeenCalledTimes(2);
    expect(subject.exitFn).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it('asks once, covering them all', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const subject = deps({
      positions: [POSITION, {...POSITION, tokenId: 999n}],
      confirm,
    });

    await runExitCommand(subject);

    expect(confirm).toHaveBeenCalledOnce();
  });
});
