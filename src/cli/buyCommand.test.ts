import {describe, expect, it, vi} from 'vitest';
import type {Config} from '../config/config.js';
import {
  buildSummary,
  runBuyCommand,
  type BuyCommandDeps,
} from './buyCommand.js';

const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const config: Config = {
  seed: 'test test test test test test test test test test test junk',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  chainId: 4663,
  arcusRouterUrl: 'https://router.spot.arcus.xyz/v1',
  stockTokenAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  usdgBuyAmount: '100',
  slippageBps: 1,
  rangeDeviationPercent: 3,
  poolFee: 3000,
  poolTickSpacing: 60,
  lpSlippageBps: 50,
  mintDeadlineSeconds: 300,
  poolCheckIntervalSeconds: 30,
  exitConfirmations: 3,
  positionLookbackBlocks: 500_000,
  closeSlippageBps: 100,
};

function deps(
  overrides: Partial<BuyCommandDeps> = {},
): BuyCommandDeps & {executeBuy: ReturnType<typeof vi.fn>} {
  const executeBuy = vi.fn().mockResolvedValue({
    tradeId: 'trade-1',
    txHash: '0xabc',
    orderId: undefined,
    sellAmount: '100000000',
    buyAmount: '500000000000000000',
    minBuyAmount: '499000000000000000',
  });

  return {
    config,
    walletAddress: WALLET,
    tradeId: 'trade-1',
    sellSymbol: 'USDG',
    buyService: {executeBuy},
    confirm: vi.fn().mockResolvedValue(true),
    print: vi.fn(),
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

  it('trades only after approval', async () => {
    const subject = deps();

    const result = await runBuyCommand(subject);

    expect(subject.confirm).toHaveBeenCalledOnce();
    expect(result?.txHash).toBe('0xabc');
    expect(subject.executeBuy).toHaveBeenCalledWith({
      tradeId: 'trade-1',
      buyToken: config.stockTokenAddress,
      sellAmount: '100',
      slippageBps: 1,
    });
  });
});

describe('buildSummary', () => {
  it('names the wallet, amount, token, chain, and slippage', () => {
    const summary = buildSummary(config, WALLET, 'USDG');

    expect(summary).toContain(WALLET);
    expect(summary).toContain('100 USDG');
    expect(summary).toContain(config.stockTokenAddress);
    expect(summary).toContain('4663');
    expect(summary).toContain('1 bps (0.01%)');
    expect(summary).toContain('PRODUCTION');
  });

  it('never includes the seed', () => {
    expect(buildSummary(config, WALLET, 'USDG')).not.toContain('junk');
  });
});
