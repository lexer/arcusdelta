import {describe, expect, it, vi} from 'vitest';
import {ArcusTwapPartialFillError} from '../arcus/errors.js';
import {
  buildBuySummary,
  runBuyCommand,
  type BuyCommandDeps,
  type BuyRequestItem,
} from './buyCommand.js';

const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const NVDA_ITEM: BuyRequestItem = {
  symbol: 'NVDA',
  stockTokenAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  usdgBuyAmount: '100',
  slippageBps: 1,
  twapChunks: 1,
  twapIntervalSeconds: 10,
};

const AAPL_ITEM: BuyRequestItem = {
  symbol: 'AAPL',
  stockTokenAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  usdgBuyAmount: '50',
  slippageBps: 5,
  twapChunks: 1,
  twapIntervalSeconds: 10,
};

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    tradeId: 'trade-1',
    txHashes: ['0xabc'],
    orderId: undefined,
    sellAmount: '100000000',
    buyAmount: '500000000000000000',
    minBuyAmount: '499000000000000000',
    ...overrides,
  };
}

function deps(
  overrides: Partial<BuyCommandDeps> = {},
): BuyCommandDeps & {executeBuy: ReturnType<typeof vi.fn>} {
  const executeBuy = vi.fn().mockResolvedValue(makeResult());
  let counter = 0;

  return {
    items: [NVDA_ITEM],
    walletAddress: WALLET,
    chainId: 4663,
    arcusRouterUrl: 'https://router.spot.arcus.xyz/v1',
    sellSymbol: 'USDG',
    buyService: {executeBuy},
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
    newTradeId: () => `trade-${++counter}`,
    executeBuy,
    ...overrides,
  };
}

describe('confirmation gate', () => {
  it('does not trade when the operator declines', async () => {
    const subject = deps({confirm: vi.fn().mockResolvedValue(false)});

    const result = await runBuyCommand(subject);

    expect(result).toBeUndefined();
    expect(subject.executeBuy).not.toHaveBeenCalled();
  });

  it('trades only after approval, covering every selected symbol', async () => {
    const subject = deps({items: [NVDA_ITEM, AAPL_ITEM]});

    const outcomes = await runBuyCommand(subject);

    expect(subject.confirm).toHaveBeenCalledOnce();
    expect(outcomes).toHaveLength(2);
    expect(subject.executeBuy).toHaveBeenCalledTimes(2);
    expect(subject.executeBuy).toHaveBeenCalledWith(
      expect.objectContaining({
        buyToken: NVDA_ITEM.stockTokenAddress,
        sellAmount: '100',
        slippageBps: 1,
      }),
    );
    expect(subject.executeBuy).toHaveBeenCalledWith(
      expect.objectContaining({
        buyToken: AAPL_ITEM.stockTokenAddress,
        sellAmount: '50',
        slippageBps: 5,
      }),
    );
  });

  it('gives each buy its own trade id', async () => {
    const subject = deps({items: [NVDA_ITEM, AAPL_ITEM]});

    await runBuyCommand(subject);

    const tradeIds = subject.executeBuy.mock.calls.map(c => c[0].tradeId);
    expect(new Set(tradeIds).size).toBe(2);
  });

  it('reports no-op when nothing is selected', async () => {
    const subject = deps({items: []});

    const outcomes = await runBuyCommand(subject);

    expect(outcomes).toEqual([]);
    expect(subject.confirm).not.toHaveBeenCalled();
  });
});

describe('partial failure', () => {
  it("continues past one symbol's failure and reports both outcomes", async () => {
    const executeBuy = vi
      .fn()
      .mockRejectedValueOnce(new Error('no arcus quote'))
      .mockResolvedValueOnce(makeResult());
    const subject = deps({
      items: [NVDA_ITEM, AAPL_ITEM],
      buyService: {executeBuy},
    });

    const outcomes = await runBuyCommand(subject);

    expect(outcomes).toHaveLength(2);
    expect(outcomes![0]).toMatchObject({
      symbol: 'NVDA',
      error: 'no arcus quote',
    });
    expect(outcomes![1]).toMatchObject({symbol: 'AAPL'});
    expect(outcomes![1]!.result).toBeDefined();
  });

  it('reports how many TWAP chunks already filled when a chunk fails mid-sequence', async () => {
    const executeBuy = vi.fn().mockRejectedValueOnce(
      new ArcusTwapPartialFillError(
        'TWAP chunk 3 of 5 failed: router unavailable',
        'trade-1',
        [
          {txHash: '0x1', sellAmount: '20', buyAmount: '100'},
          {txHash: '0x2', sellAmount: '20', buyAmount: '100'},
        ],
        3,
        5,
      ),
    );
    const print = vi.fn();
    const subject = deps({items: [NVDA_ITEM], buyService: {executeBuy}, print});

    await runBuyCommand(subject);

    const printed = print.mock.calls.map(call => call[0]).join('\n');
    expect(printed).toContain('2 of 5 chunks already filled');
  });
});

describe('buildBuySummary', () => {
  it('names the wallet, chain, and every symbol with its own amount and slippage', () => {
    const summary = buildBuySummary([NVDA_ITEM, AAPL_ITEM], {
      walletAddress: WALLET,
      chainId: 4663,
      arcusRouterUrl: 'https://router.spot.arcus.xyz/v1',
      sellSymbol: 'USDG',
    });

    expect(summary).toContain(WALLET);
    expect(summary).toContain('4663');
    expect(summary).toContain('NVDA');
    expect(summary).toContain('100 USDG');
    expect(summary).toContain(NVDA_ITEM.stockTokenAddress);
    expect(summary).toContain('AAPL');
    expect(summary).toContain('50 USDG');
    expect(summary).toContain('5 bps');
    expect(summary).toContain('PRODUCTION');
  });

  it('pluralizes correctly for a single symbol', () => {
    const summary = buildBuySummary([NVDA_ITEM], {
      walletAddress: WALLET,
      chainId: 4663,
      arcusRouterUrl: 'https://router.spot.arcus.xyz/v1',
      sellSymbol: 'USDG',
    });

    expect(summary).toContain('1 symbol from');
  });

  it('mentions TWAP chunking only for a symbol that has it enabled', () => {
    const summary = buildBuySummary(
      [NVDA_ITEM, {...AAPL_ITEM, twapChunks: 4, twapIntervalSeconds: 15}],
      {
        walletAddress: WALLET,
        chainId: 4663,
        arcusRouterUrl: 'https://router.spot.arcus.xyz/v1',
        sellSymbol: 'USDG',
      },
    );

    const lines = summary.split('\n');
    expect(lines.find(l => l.includes('NVDA'))).not.toContain('TWAP');
    expect(lines.find(l => l.includes('AAPL'))).toContain(
      'TWAP: 4 chunks, 15s apart',
    );
  });
});
