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
const NVDA_POOL_ADDRESS = '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B';

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

// The live pool: tick 223440, USDG is token0.
const POOL_STATE: PoolState = {
  poolAddress: NVDA_POOL_ADDRESS,
  sqrtPriceX96: getSqrtRatioAtTick(223440),
  tick: 223440,
  liquidity: 817_184_618_165_972_105n,
};

interface HarnessOptions {
  stockBalance?: bigint;
  usdgBalance?: bigint;
  poolState?: PoolState | Error;
  /** ERC20 allowance to the position manager. Defaults to unlimited. */
  allowance?: bigint;
}

function harness(options: HarnessOptions = {}) {
  const stockBalance = options.stockBalance ?? 25_178_400_616_157_272n;
  const usdgBalance = options.usdgBalance ?? 1_000_000_000n;
  const allowance = options.allowance ?? 2n ** 256n - 1n;

  const readContract = vi.fn(({address, functionName}) => {
    if (functionName === 'balanceOf') {
      return Promise.resolve(
        address === NVDA.address ? stockBalance : usdgBalance,
      );
    }
    if (functionName === 'allowance') return Promise.resolve(allowance);
    if (functionName === 'getPool') return Promise.resolve(NVDA_POOL_ADDRESS);
    if (functionName === 'feeAmountTickSpacing') return Promise.resolve(60);
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

  it('resolves the pool via the live factory, not an offline computation', async () => {
    const {service, readState} = harness();

    const plan = await service.plan();

    expect(plan.pool.address).toBe(NVDA_POOL_ADDRESS);
    expect(readState).toHaveBeenCalledWith(
      expect.objectContaining({address: NVDA_POOL_ADDRESS}),
    );
  });

  it('commits no more stock than the wallet holds', async () => {
    const stockBalance = 25_178_400_616_157_272n;
    const {service} = harness({stockBalance});

    const plan = await service.plan();

    expect(plan.stockAmount).toBeLessThanOrEqual(stockBalance);
  });

  it('gives the USDG side headroom, but not the stock side', async () => {
    const {service} = harness();

    const plan = await service.plan();

    // USDG is token0 (amount0) for this pair, stock is token1 (amount1).
    expect(plan.amount0Desired).toBeGreaterThanOrEqual(plan.usdgAmount);
    expect(plan.amount0Min).toBeLessThanOrEqual(plan.usdgAmount);
    expect(plan.amount0Desired).toBe((plan.usdgAmount * 10_050n) / 10_000n);
    expect(plan.amount0Min).toBe((plan.usdgAmount * 9_950n) / 10_000n);
    // The stock ceiling stays exactly at the computed amount.
    expect(plan.amount1Desired).toBe(plan.stockAmount);
  });

  it('never asks the mint to pull more stock than the wallet holds', async () => {
    // Regression test: applying headroom to both sides scales the desired
    // ratio uniformly, so v3's mint() computes MORE liquidity than intended
    // and pulls more stock token than the wallet has -- NFPM.mint() then
    // reverts with "STF" (TransferHelper.safeTransferFrom failure). Confirmed
    // live: this was a 100%-reproducing bug in every deposit before the fix.
    const stockBalance = 321_961_365_328_533_640n;
    const {service} = harness({stockBalance});

    const plan = await service.plan();

    // USDG is token0, stock is token1 for this pair.
    expect(plan.amount1Desired).toBeLessThanOrEqual(stockBalance);
  });

  it('holds the same invariant when the stock token sorts as token0', async () => {
    // Real token addresses can sort either way; USDG happened to be token0
    // in every pool used so far, so this exercises the other branch of the
    // stockIsToken0 check directly rather than relying on that coincidence.
    const LOW_STOCK: TokenMeta = {
      address: '0x0000000000000000000000000000000000000001',
      symbol: 'LOWSTOCK',
      decimals: 18,
    };
    const poolAddress = '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B';
    const stockBalance = 25_178_400_616_157_272n;
    const usdgBalance = 10n ** 30n; // ample; only the branch matters here

    const readContract = vi.fn(({address, functionName}) => {
      if (functionName === 'balanceOf') {
        return Promise.resolve(
          address === LOW_STOCK.address ? stockBalance : usdgBalance,
        );
      }
      if (functionName === 'allowance') return Promise.resolve(2n ** 256n - 1n);
      if (functionName === 'getPool') return Promise.resolve(poolAddress);
      if (functionName === 'feeAmountTickSpacing') return Promise.resolve(60);
      throw new Error(`unexpected read: ${functionName}`);
    });
    const wallet: WalletProvider = {
      getAccount: () => ({address: OWNER}) as never,
      getWalletClient: () => ({account: {address: OWNER}}) as never,
      getPublicClient: () => ({readContract}) as never,
    };
    const service = new DepositService({
      wallet,
      poolReader: {
        readState: vi.fn().mockResolvedValue({
          poolAddress,
          sqrtPriceX96: getSqrtRatioAtTick(0),
          tick: 0,
          liquidity: 1_000_000n,
        } satisfies PoolState),
      },
      logger: pino({level: 'silent'}),
      chainId: 4663,
      usdg: USDG,
      stock: LOW_STOCK,
      rangeDeviationPercent: 3,
      poolFee: 3000,
      lpSlippageBps: 50,
      mintDeadlineSeconds: 300,
    });

    const plan = await service.plan();

    expect(plan.amount0Desired).toBe(plan.stockAmount);
    expect(plan.amount1Desired).toBeGreaterThanOrEqual(plan.usdgAmount);
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
    const error = new PoolNotInitializedError(NVDA_POOL_ADDRESS);
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

  it('sends no approvals when the existing allowance suffices', async () => {
    const {service, writeContract} = harness();
    const plan = await service.plan();

    const result = await service.execute(plan);

    expect(result.approvalHashes).toEqual([]);
    // Only the mint itself was written.
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('approves the position manager when the allowance is short', async () => {
    const {service, writeContract} = harness({allowance: 0n});
    const plan = await service.plan();

    const result = await service.execute(plan);

    // One approval per token, plus the mint.
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
