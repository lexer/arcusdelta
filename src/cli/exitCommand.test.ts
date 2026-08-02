import {describe, expect, it, vi} from 'vitest';
import type {Hex} from 'viem';
import type {TokenMeta} from '../uniswap/depositService.js';
import type {ExitPlan} from '../uniswap/positionExitService.js';
import type {OwnedPosition} from '../uniswap/positionReader.js';
import {
  buildExitSummary,
  runExitCommand,
  type ExitCommandDeps,
  type ExitRequestItem,
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

const AAPL: TokenMeta = {
  address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  symbol: 'AAPL',
  decimals: 18,
};

const NVDA_POSITION: OwnedPosition = {
  tokenId: 422596n,
  tickLower: 223080,
  tickUpper: 223740,
  liquidity: 60_210_398_382_745n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
};

const AAPL_POSITION: OwnedPosition = {
  tokenId: 560470n,
  tickLower: 218820,
  tickUpper: 219060,
  liquidity: 926_585_679_398_857n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
};

function makePlan(position: OwnedPosition): ExitPlan {
  return {
    position,
    principalUsdg: 12_288_029n,
    principalStock: 77_971_818_932_109_303n,
    fees0: 13_002n,
    fees1: 72_064_323_237_819n,
    amount0Min: 12_165_148n,
    amount1Min: 77_192_100_742_788_210n,
  };
}

function makeExitResult(position: OwnedPosition) {
  return {
    tokenId: position.tokenId,
    closeHash: '0xc105e' as Hex,
    stockSold: 77_971_818_932_109_303n,
    saleTxHash: '0x5e11' as Hex,
    usdgReceived: '15400000',
  };
}

function makeItem(
  symbol: string,
  stock: TokenMeta,
  positions: readonly OwnedPosition[],
  overrides: Partial<ExitRequestItem> = {},
): ExitRequestItem & {
  planFn: ReturnType<typeof vi.fn>;
  exitFn: ReturnType<typeof vi.fn>;
} {
  const planFn = vi.fn((position: OwnedPosition) =>
    Promise.resolve(makePlan(position)),
  );
  const exitFn = vi.fn((plan: ExitPlan) =>
    Promise.resolve(makeExitResult(plan.position)),
  );

  return {
    symbol,
    usdg: USDG,
    stock,
    positions,
    sqrtPriceX96: 5_630_988_710_377_423_664_134_631_725_262_565n,
    exitService: {plan: planFn, exit: exitFn},
    planFn,
    exitFn,
    ...overrides,
  };
}

function deps(overrides: Partial<ExitCommandDeps> = {}): ExitCommandDeps {
  return {
    items: [makeItem('NVDA', NVDA, [NVDA_POSITION])],
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
    dryRun: false,
    ...overrides,
  };
}

describe('confirmation gate', () => {
  it('withdraws nothing when the operator declines', async () => {
    const item = makeItem('NVDA', NVDA, [NVDA_POSITION]);
    const subject = deps({
      items: [item],
      confirm: vi.fn().mockResolvedValue(false),
    });

    const result = await runExitCommand(subject);

    expect(result).toBeUndefined();
    expect(item.exitFn).not.toHaveBeenCalled();
  });

  it('plans before asking, so real numbers are shown', async () => {
    const item = makeItem('NVDA', NVDA, [NVDA_POSITION]);
    const subject = deps({
      items: [item],
      confirm: vi.fn().mockResolvedValue(false),
    });

    await runExitCommand(subject);

    expect(item.planFn).toHaveBeenCalledOnce();
  });

  it('exits the very plan that was shown', async () => {
    const item = makeItem('NVDA', NVDA, [NVDA_POSITION]);
    const subject = deps({items: [item]});

    const results = await runExitCommand(subject);

    expect(item.exitFn).toHaveBeenCalledWith(
      expect.objectContaining({position: NVDA_POSITION}),
    );
    expect(results?.[0]?.result?.closeHash).toBe('0xc105e');
  });
});

describe('dry run', () => {
  it('never withdraws, and never even asks', async () => {
    const confirm = vi.fn();
    const subject = deps({dryRun: true, confirm});

    const result = await runExitCommand(subject);

    expect(result).toBeUndefined();
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
    const subject = deps({items: [makeItem('NVDA', NVDA, [])], confirm});

    const result = await runExitCommand(subject);

    expect(result).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('buildExitSummary', () => {
  it('states the symbol, principal, fees, and the guaranteed minimums', () => {
    const summary = buildExitSummary([
      {
        item: makeItem('NVDA', NVDA, [NVDA_POSITION]),
        plan: makePlan(NVDA_POSITION),
      },
    ]);

    expect(summary).toContain('NVDA #422596');
    expect(summary).toContain('12.288029 USDG');
    expect(summary).toContain('0.077971818932109303 NVDA');
    expect(summary).toContain('0.013002 USDG');
    expect(summary).toContain('at least');
    expect(summary).toContain('12.165148 USDG');
  });

  it('says the fees are claimed and the stock is sold', () => {
    const summary = buildExitSummary([
      {
        item: makeItem('NVDA', NVDA, [NVDA_POSITION]),
        plan: makePlan(NVDA_POSITION),
      },
    ]);

    expect(summary).toContain('claim fees');
    expect(summary).toContain('Arcus');
    expect(summary).toContain('PRODUCTION');
  });

  it('pluralizes correctly for a single position', () => {
    const summary = buildExitSummary([
      {
        item: makeItem('NVDA', NVDA, [NVDA_POSITION]),
        plan: makePlan(NVDA_POSITION),
      },
    ]);

    expect(summary).toContain('1 liquidity position,');
  });
});

describe('multiple positions in one symbol', () => {
  it('exits each one', async () => {
    const second = {...NVDA_POSITION, tokenId: 999n};
    const item = makeItem('NVDA', NVDA, [NVDA_POSITION, second]);
    const subject = deps({items: [item]});

    const results = await runExitCommand(subject);

    expect(item.planFn).toHaveBeenCalledTimes(2);
    expect(item.exitFn).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it('asks once, covering them all', async () => {
    const second = {...NVDA_POSITION, tokenId: 999n};
    const confirm = vi.fn().mockResolvedValue(true);
    const subject = deps({
      items: [makeItem('NVDA', NVDA, [NVDA_POSITION, second])],
      confirm,
    });

    await runExitCommand(subject);

    expect(confirm).toHaveBeenCalledOnce();
  });
});

describe('multiple symbols', () => {
  it('exits positions across different pools in one batch', async () => {
    const nvda = makeItem('NVDA', NVDA, [NVDA_POSITION]);
    const aapl = makeItem('AAPL', AAPL, [AAPL_POSITION]);
    const subject = deps({items: [nvda, aapl]});

    const results = await runExitCommand(subject);

    expect(nvda.exitFn).toHaveBeenCalledTimes(1);
    expect(aapl.exitFn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
  });

  it('asks once for every symbol combined', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const subject = deps({
      items: [
        makeItem('NVDA', NVDA, [NVDA_POSITION]),
        makeItem('AAPL', AAPL, [AAPL_POSITION]),
      ],
      confirm,
    });

    await runExitCommand(subject);

    expect(confirm).toHaveBeenCalledOnce();
    const summary = confirm.mock.calls[0]![0] as string;
    expect(summary).toContain('NVDA');
    expect(summary).toContain('AAPL');
  });

  it('mixes symbols with no open positions in with symbols that have some', async () => {
    const nvda = makeItem('NVDA', NVDA, [NVDA_POSITION]);
    const aapl = makeItem('AAPL', AAPL, []);
    const subject = deps({items: [nvda, aapl]});

    const results = await runExitCommand(subject);

    expect(results).toHaveLength(1);
    expect(results?.[0]?.symbol).toBe('NVDA');
  });
});

describe('partial failure', () => {
  it('skips a position that fails to plan, but still confirms and exits the rest', async () => {
    const failing = makeItem('NVDA', NVDA, [NVDA_POSITION], {
      exitService: {
        plan: vi.fn().mockRejectedValue(new Error('pool not initialized')),
        exit: vi.fn(),
      },
    });
    const ok = makeItem('AAPL', AAPL, [AAPL_POSITION]);
    const confirm = vi.fn().mockResolvedValue(true);
    const subject = deps({items: [failing, ok], confirm});

    const outcomes = await runExitCommand(subject);

    expect(confirm).toHaveBeenCalledOnce();
    expect(ok.exitFn).toHaveBeenCalled();
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        symbol: 'NVDA',
        tokenId: 422596n,
        error: 'pool not initialized',
      }),
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({symbol: 'AAPL', tokenId: 560470n}),
    );
  });

  it('never confirms when every position fails to plan', async () => {
    const failing = makeItem('NVDA', NVDA, [NVDA_POSITION], {
      exitService: {
        plan: vi.fn().mockRejectedValue(new Error('pool not initialized')),
        exit: vi.fn(),
      },
    });
    const confirm = vi.fn();
    const subject = deps({items: [failing], confirm});

    const outcomes = await runExitCommand(subject);

    expect(confirm).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      {symbol: 'NVDA', tokenId: 422596n, error: 'pool not initialized'},
    ]);
  });

  it('continues past one exit failure and reports both outcomes', async () => {
    const failing = makeItem('NVDA', NVDA, [NVDA_POSITION], {
      exitService: {
        plan: vi.fn((position: OwnedPosition) =>
          Promise.resolve(makePlan(position)),
        ),
        exit: vi.fn().mockRejectedValue(new Error('close reverted')),
      },
    });
    const ok = makeItem('AAPL', AAPL, [AAPL_POSITION]);
    const subject = deps({items: [failing, ok]});

    const outcomes = await runExitCommand(subject);

    expect(outcomes).toContainEqual(
      expect.objectContaining({symbol: 'NVDA', error: 'close reverted'}),
    );
    expect(outcomes).toContainEqual(expect.objectContaining({symbol: 'AAPL'}));
  });
});
