import {describe, expect, it, vi} from 'vitest';
import {pino} from 'pino';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {TokenMeta} from './depositService.js';
import {createPoolKey} from './poolKey.js';
import {
  PositionExitService,
  type PositionExitServiceOptions,
} from './positionExitService.js';
import type {OwnedPosition} from './positionReader.js';
import {getSqrtRatioAtTick} from './tickMath.js';

const OWNER = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';

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

const IN_RANGE = getSqrtRatioAtTick(223447);

interface HarnessOptions {
  stockBalance?: bigint;
  fees?: {fees0: bigint; fees1: bigint};
}

function harness(options: HarnessOptions = {}) {
  const simulateContract = vi.fn().mockResolvedValue({request: {}});
  const writeContract = vi.fn().mockResolvedValue('0xc105e');
  const readContract = vi
    .fn()
    .mockResolvedValue(options.stockBalance ?? 77_971_818_932_109_303n);

  const walletClient = {account: {address: OWNER}, writeContract};
  const publicClient = {
    readContract,
    simulateContract,
    waitForTransactionReceipt: vi
      .fn()
      .mockResolvedValue({status: 'success', logs: [], gasUsed: 100n}),
  };

  const wallet: WalletProvider = {
    getAccount: () => ({address: OWNER}) as never,
    getWalletClient: () => walletClient as never,
    getPublicClient: () => publicClient as never,
  };

  const executeSell = vi
    .fn()
    .mockResolvedValue({txHash: '0x5e11', buyAmount: '15400000'});

  const serviceOptions: PositionExitServiceOptions = {
    wallet,
    feeReader: {
      read: vi
        .fn()
        .mockResolvedValue(
          options.fees ?? {fees0: 13_002n, fees1: 72_064_323_237_819n},
        ),
    },
    swapService: {executeSell},
    logger: pino({level: 'silent'}),
    chainId: 4663,
    poolKey: createPoolKey(USDG.address, NVDA.address, 3000, 60),
    usdg: USDG,
    stock: NVDA,
    closeSlippageBps: 100,
    sellSlippageBps: 1,
    deadlineSeconds: 300,
  };

  return {
    service: new PositionExitService(serviceOptions),
    simulateContract,
    writeContract,
    executeSell,
  };
}

describe('plan', () => {
  it('separates principal from the fees the burn will also return', async () => {
    const {service} = harness();

    const plan = await service.plan(POSITION, IN_RANGE);

    expect(plan.principalUsdg).toBeGreaterThan(0n);
    expect(plan.principalStock).toBeGreaterThan(0n);
    expect(plan.fees0).toBe(13_002n);
    expect(plan.fees1).toBe(72_064_323_237_819n);
  });

  it('sets minimums below the principal by the close slippage', async () => {
    const {service} = harness();

    const plan = await service.plan(POSITION, IN_RANGE);

    expect(plan.amount0Min).toBeLessThan(plan.principalUsdg);
    expect(plan.amount1Min).toBeLessThan(plan.principalStock);
    expect(plan.amount0Min).toBe((plan.principalUsdg * 9_900n) / 10_000n);
  });

  it('sends nothing', async () => {
    const {service, simulateContract, writeContract} = harness();

    await service.plan(POSITION, IN_RANGE);

    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('exit', () => {
  it('closes then sells, in that order', async () => {
    const {service, writeContract, executeSell} = harness();
    const plan = await service.plan(POSITION, IN_RANGE);

    const result = await service.exit(plan);

    expect(writeContract.mock.invocationCallOrder[0]!).toBeLessThan(
      executeSell.mock.invocationCallOrder[0]!,
    );
    expect(result.closeHash).toBe('0xc105e');
    expect(result.saleTxHash).toBe('0x5e11');
  });

  it('simulates before broadcasting the burn', async () => {
    const {service, simulateContract, writeContract} = harness();
    const plan = await service.plan(POSITION, IN_RANGE);

    await service.exit(plan);

    expect(simulateContract.mock.invocationCallOrder[0]!).toBeLessThan(
      writeContract.mock.invocationCallOrder[0]!,
    );
  });

  it('does not broadcast when the simulation reverts', async () => {
    const {service, simulateContract, writeContract, executeSell} = harness();
    const plan = await service.plan(POSITION, IN_RANGE);
    simulateContract.mockRejectedValue(new Error('execution reverted'));

    await expect(service.exit(plan)).rejects.toThrow(/reverted/);
    expect(writeContract).not.toHaveBeenCalled();
    expect(executeSell).not.toHaveBeenCalled();
  });

  it('sells the whole balance the close returned', async () => {
    const {service, executeSell} = harness({stockBalance: 12_345n});
    const plan = await service.plan(POSITION, IN_RANGE);

    await service.exit(plan);

    expect(executeSell).toHaveBeenCalledWith(
      expect.objectContaining({sellAmountAtoms: 12_345n}),
    );
  });

  it('skips the sale when the close returned no stock', async () => {
    const {service, executeSell} = harness({stockBalance: 0n});
    const plan = await service.plan(POSITION, IN_RANGE);

    const result = await service.exit(plan);

    expect(executeSell).not.toHaveBeenCalled();
    expect(result.stockSold).toBe(0n);
    expect(result.saleTxHash).toBeUndefined();
  });

  it('shares one trade id across the close and the sale', async () => {
    const {service, executeSell} = harness();
    const plan = await service.plan(POSITION, IN_RANGE);

    await service.exit(plan, 'trace-me');

    expect(executeSell).toHaveBeenCalledWith(
      expect.objectContaining({tradeId: 'trace-me'}),
    );
  });
});
