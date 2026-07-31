import {describe, expect, it, vi} from 'vitest';
import {pino} from 'pino';
import type {WalletProvider} from '../chain/walletProvider.js';
import {
  DepositService,
  InsufficientBalanceError,
  type DepositServiceOptions,
  type TokenMeta,
} from './depositService.js';
import {PoolNotInitializedError, type PoolState} from './poolReader.js';
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

// The live pool: tick 223440, USDG is currency0.
const POOL_STATE: PoolState = {
  poolId: `0x${'3b'.repeat(32)}`,
  sqrtPriceX96: getSqrtRatioAtTick(223440),
  tick: 223440,
  lpFee: 3000,
  liquidity: 817_184_618_165_972_105n,
};

const MAX_UINT160 = 2n ** 160n - 1n;
const FAR_FUTURE = 2n ** 48n - 1n;

interface HarnessOptions {
  stockBalance?: bigint;
  usdgBalance?: bigint;
  poolState?: PoolState | Error;
  /** ERC20 allowance to Permit2. Defaults to unlimited. */
  erc20Allowance?: bigint;
  /** Permit2 allowance to PositionManager. Defaults to unlimited. */
  permit2Allowance?: bigint;
}

function harness(options: HarnessOptions = {}) {
  const stockBalance = options.stockBalance ?? 25_178_400_616_157_272n;
  const usdgBalance = options.usdgBalance ?? 1_000_000_000n;
  const erc20Allowance = options.erc20Allowance ?? 2n ** 256n - 1n;
  const permit2Allowance = options.permit2Allowance ?? MAX_UINT160;

  const readContract = vi.fn(({address, functionName, args}) => {
    if (functionName === 'balanceOf') {
      return Promise.resolve(
        address === NVDA.address ? stockBalance : usdgBalance,
      );
    }
    if (functionName === 'allowance') {
      // ERC20.allowance(owner, spender) vs Permit2.allowance(owner, token, spender).
      return args.length === 2
        ? Promise.resolve(erc20Allowance)
        : Promise.resolve([permit2Allowance, FAR_FUTURE, 0n]);
    }
    throw new Error(`unexpected read: ${functionName}`);
  });

  const simulateContract = vi.fn().mockResolvedValue({request: {}});
  const writeContract = vi.fn().mockResolvedValue('0xdead');
  const waitForTransactionReceipt = vi
    .fn()
    .mockResolvedValue({status: 'success', logs: [], gasUsed: 100n});

  // Built once: the service holds on to these across calls.
  const walletClient = {account: {address: OWNER}, writeContract};
  const publicClient = {
    readContract,
    simulateContract,
    waitForTransactionReceipt,
  };

  const wallet: WalletProvider = {
    getAccount: () => ({address: OWNER}) as never,
    getWalletClient: () => walletClient as never,
    getPublicClient: () => publicClient as never,
  };

  const readState = vi.fn(() =>
    options.poolState instanceof Error
      ? Promise.reject(options.poolState)
      : Promise.resolve(options.poolState ?? POOL_STATE),
  );

  const serviceOptions: DepositServiceOptions = {
    wallet,
    poolReader: {readState},
    logger: pino({level: 'silent'}),
    chainId: 4663,
    usdg: USDG,
    stock: NVDA,
    rangeDeviationPercent: 3,
    poolFee: 3000,
    poolTickSpacing: 60,
    lpSlippageBps: 50,
    mintDeadlineSeconds: 300,
  };

  return {
    service: new DepositService(serviceOptions),
    readState,
    simulateContract,
    writeContract,
  };
}

describe('plan', () => {
  it('brackets the pool tick and derives both sides', async () => {
    const {service} = harness();

    const plan = await service.plan();

    expect(plan.currentTick).toBe(223440);
    expect(plan.tickLower).toBeLessThan(223440);
    expect(plan.tickUpper).toBeGreaterThan(223440);
    expect(plan.liquidity).toBeGreaterThan(0n);
    expect(plan.stockAmount).toBeGreaterThan(0n);
    expect(plan.usdgAmount).toBeGreaterThan(0n);
  });

  it('commits no more stock than the wallet holds', async () => {
    const stockBalance = 25_178_400_616_157_272n;
    const {service} = harness({stockBalance});

    const plan = await service.plan();

    expect(plan.stockAmount).toBeLessThanOrEqual(stockBalance);
  });

  it('caps the pull above the computed amounts by the slippage bps', async () => {
    const {service} = harness();

    const plan = await service.plan();

    // USDG is currency0 for this pair.
    expect(plan.amount0Max).toBeGreaterThanOrEqual(plan.usdgAmount);
    expect(plan.amount1Max).toBeGreaterThanOrEqual(plan.stockAmount);
    expect(plan.amount0Max).toBe((plan.usdgAmount * 10_050n) / 10_000n);
  });

  it('is read-only', async () => {
    const {service, simulateContract, writeContract} = harness();

    await service.plan();

    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('rejects when the wallet holds no stock token', async () => {
    const {service} = harness({stockBalance: 0n});

    await expect(service.plan()).rejects.toThrow(InsufficientBalanceError);
  });

  it('rejects when USDG is short, naming both amounts', async () => {
    const {service} = harness({usdgBalance: 1n});

    await expect(service.plan()).rejects.toThrow(InsufficientBalanceError);
    await expect(service.plan()).rejects.toThrow(/USDG/);
  });

  it('propagates an uninitialized pool', async () => {
    const error = new PoolNotInitializedError(`0x${'00'.repeat(32)}`, {
      currency0: USDG.address,
      currency1: NVDA.address,
      fee: 3000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
    });
    const {service} = harness({poolState: error});

    await expect(service.plan()).rejects.toThrow(PoolNotInitializedError);
  });
});

describe('execute', () => {
  it('simulates before writing', async () => {
    const {service, simulateContract, writeContract} = harness();
    const plan = await service.plan();

    await service.execute(plan);

    expect(simulateContract).toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalled();
    const firstSimulate = simulateContract.mock.invocationCallOrder[0]!;
    const firstWrite = writeContract.mock.invocationCallOrder[0]!;
    expect(firstSimulate).toBeLessThan(firstWrite);
  });

  it('does not broadcast when the simulation reverts', async () => {
    const {service, simulateContract, writeContract} = harness();
    const plan = await service.plan();
    simulateContract.mockRejectedValue(new Error('execution reverted'));

    await expect(service.execute(plan)).rejects.toThrow(/reverted/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('sends no approvals when the existing allowances suffice', async () => {
    const {service, writeContract} = harness();
    const plan = await service.plan();

    const result = await service.execute(plan);

    expect(result.approvalHashes).toEqual([]);
    // Only the mint itself was written.
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('approves Permit2 when the ERC20 allowance is short', async () => {
    const {service, writeContract} = harness({erc20Allowance: 0n});
    const plan = await service.plan();

    const result = await service.execute(plan);

    // One approval per token, plus the mint.
    expect(result.approvalHashes).toHaveLength(2);
    expect(writeContract).toHaveBeenCalledTimes(3);
  });

  it('approves the position manager when the Permit2 allowance is short', async () => {
    const {service, writeContract} = harness({permit2Allowance: 0n});
    const plan = await service.plan();

    const result = await service.execute(plan);

    expect(result.approvalHashes).toHaveLength(2);
    expect(writeContract).toHaveBeenCalledTimes(3);
  });

  it('reports the plan alongside the mint result', async () => {
    const {service} = harness();
    const plan = await service.plan();

    const result = await service.execute(plan);

    expect(result.plan).toBe(plan);
    expect(result.hash).toBe('0xdead');
  });
});
