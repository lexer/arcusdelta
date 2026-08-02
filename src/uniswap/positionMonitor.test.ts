import {describe, expect, it, vi} from 'vitest';
import {pino} from 'pino';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {TokenMeta} from './depositService.js';
import type {PoolIdentity} from './poolAddress.js';
import type {PoolState} from './poolReader.js';
import {
  BreachCounter,
  classifyTick,
  PositionMonitor,
  type PositionMonitorOptions,
} from './positionMonitor.js';
import {PositionExitService} from './positionExitService.js';
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

// The live position.
const POSITION: OwnedPosition = {
  tokenId: 422596n,
  tickLower: 223080,
  tickUpper: 223740,
  liquidity: 60_210_398_382_745n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
};

const POOL: PoolIdentity = {
  token0: USDG.address,
  token1: NVDA.address,
  fee: 3000,
  tickSpacing: 60,
  address: '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B',
};

describe('classifyTick', () => {
  it('reports in-range strictly inside the bounds', () => {
    expect(classifyTick(223400, POSITION)).toBe('in-range');
    expect(classifyTick(223081, POSITION)).toBe('in-range');
    expect(classifyTick(223739, POSITION)).toBe('in-range');
  });

  it('treats the lower bound as fully USDG', () => {
    expect(classifyTick(223080, POSITION)).toBe('below-range');
    expect(classifyTick(223079, POSITION)).toBe('below-range');
  });

  it('treats the upper bound as fully stock', () => {
    expect(classifyTick(223740, POSITION)).toBe('above-range');
    expect(classifyTick(223741, POSITION)).toBe('above-range');
  });

  it('handles a range straddling zero', () => {
    const straddling = {tickLower: -60, tickUpper: 60};

    expect(classifyTick(0, straddling)).toBe('in-range');
    expect(classifyTick(-60, straddling)).toBe('below-range');
    expect(classifyTick(60, straddling)).toBe('above-range');
  });
});

describe('BreachCounter', () => {
  it('does not trigger before the threshold', () => {
    const counter = new BreachCounter(3);

    expect(counter.record(1n, 'below-range')).toBe(false);
    expect(counter.record(1n, 'below-range')).toBe(false);
  });

  it('triggers exactly at the threshold', () => {
    const counter = new BreachCounter(3);

    counter.record(1n, 'below-range');
    counter.record(1n, 'below-range');

    expect(counter.record(1n, 'below-range')).toBe(true);
  });

  it('resets when the pool comes back into range', () => {
    const counter = new BreachCounter(3);

    counter.record(1n, 'below-range');
    counter.record(1n, 'below-range');
    counter.record(1n, 'in-range');

    expect(counter.count(1n)).toBe(0);
    expect(counter.record(1n, 'below-range')).toBe(false);
  });

  it('counts each position independently', () => {
    const counter = new BreachCounter(2);

    counter.record(1n, 'below-range');

    expect(counter.record(2n, 'above-range')).toBe(false);
    expect(counter.record(1n, 'below-range')).toBe(true);
  });

  it('triggers on the first reading when the threshold is one', () => {
    expect(new BreachCounter(1).record(1n, 'above-range')).toBe(true);
  });
});

interface HarnessOptions {
  ticks?: number[];
  dryRun?: boolean;
  stockBalance?: bigint;
  positions?: OwnedPosition[];
}

function harness(options: HarnessOptions = {}) {
  const ticks = options.ticks ?? [223400];
  let poll = 0;

  const readState = vi.fn(() => {
    const tick = ticks[Math.min(poll, ticks.length - 1)]!;
    poll++;
    return Promise.resolve({
      poolAddress: POOL.address,
      sqrtPriceX96: getSqrtRatioAtTick(tick),
      tick,
      liquidity: 817_184_618_165_972_105n,
    } satisfies PoolState);
  });

  const simulateContract = vi.fn().mockResolvedValue({request: {}});
  const writeContract = vi.fn().mockResolvedValue('0xc105e');
  const readContract = vi
    .fn()
    .mockResolvedValue(options.stockBalance ?? 25_178_400_616_157_272n);

  const walletClient = {account: {address: OWNER}, writeContract};
  const publicClient = {
    readContract,
    simulateContract,
    writeContract,
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
    .mockResolvedValue({txHash: '0x5e11', buyAmount: '5000000'});

  const logger = pino({level: 'silent'});

  // A real exit service over fake clients, so the assertions below still
  // exercise the code path the monitor actually takes.
  const exitService = new PositionExitService({
    wallet,
    feeReader: {read: vi.fn().mockResolvedValue({fees0: 0n, fees1: 0n})},
    swapService: {executeSell} as never,
    logger,
    chainId: 4663,
    pool: POOL,
    usdg: USDG,
    stock: NVDA,
    closeSlippageBps: 100,
    sellSlippageBps: 1,
    deadlineSeconds: 300,
  });

  const monitorOptions: PositionMonitorOptions = {
    wallet,
    poolReader: {readState},
    positionReader: {
      discover: vi.fn().mockResolvedValue(options.positions ?? [POSITION]),
      read: vi.fn().mockResolvedValue(POSITION),
    },
    exitService,
    logger,
    pool: POOL,
    checkIntervalSeconds: 30,
    exitConfirmations: 3,
    dryRun: options.dryRun ?? false,
    sleep: vi.fn().mockResolvedValue(undefined),
  };

  return {
    monitor: new PositionMonitor(monitorOptions),
    writeContract,
    simulateContract,
    executeSell,
    readState,
  };
}

describe('run', () => {
  it('does not close while the pool stays in range', async () => {
    const {monitor, writeContract, executeSell} = harness({ticks: [223400]});

    await monitor.run({maxPolls: 10});

    expect(writeContract).not.toHaveBeenCalled();
    expect(executeSell).not.toHaveBeenCalled();
  });

  it('does not close before the confirmation threshold', async () => {
    const {monitor, writeContract} = harness({
      ticks: [223000, 223000],
    });

    await monitor.run({maxPolls: 2});

    expect(writeContract).not.toHaveBeenCalled();
  });

  it('closes once the pool has been out of range long enough', async () => {
    const {monitor, writeContract, executeSell} = harness({
      ticks: [223000, 223000, 223000],
    });

    await monitor.run({maxPolls: 5});

    expect(writeContract).toHaveBeenCalled();
    expect(executeSell).toHaveBeenCalled();
  });

  it('does not close when a wick mean-reverts', async () => {
    const {monitor, writeContract} = harness({
      ticks: [223000, 223000, 223400, 223000, 223000],
    });

    await monitor.run({maxPolls: 5});

    expect(writeContract).not.toHaveBeenCalled();
  });

  it('closes when the pool runs above the range too', async () => {
    const {monitor, writeContract, executeSell} = harness({
      ticks: [223800, 223800, 223800],
    });

    await monitor.run({maxPolls: 5});

    expect(writeContract).toHaveBeenCalled();
    expect(executeSell).toHaveBeenCalled();
  });

  it('simulates before it writes', async () => {
    const {monitor, simulateContract, writeContract} = harness({
      ticks: [223000, 223000, 223000],
    });

    await monitor.run({maxPolls: 5});

    expect(simulateContract.mock.invocationCallOrder[0]!).toBeLessThan(
      writeContract.mock.invocationCallOrder[0]!,
    );
  });

  it('does not sell when the close returned no stock token', async () => {
    const {monitor, executeSell} = harness({
      ticks: [223000, 223000, 223000],
      stockBalance: 0n,
    });

    await monitor.run({maxPolls: 5});

    expect(executeSell).not.toHaveBeenCalled();
  });

  it('stops once every position is closed', async () => {
    const {monitor, readState} = harness({
      ticks: [223000, 223000, 223000],
    });

    await monitor.run({maxPolls: 20});

    // Stops when nothing is left, rather than polling to the limit.
    expect(readState.mock.calls.length).toBeLessThan(20);
  });

  it('returns immediately when there is nothing to watch', async () => {
    const {monitor, readState} = harness({positions: []});

    await monitor.run({maxPolls: 5});

    expect(readState).not.toHaveBeenCalled();
  });
});

describe('dry run', () => {
  it('never sends a transaction, however far out of range', async () => {
    const {monitor, writeContract, simulateContract, executeSell} = harness({
      ticks: [223000, 223000, 223000, 223000],
      dryRun: true,
    });

    await monitor.run({maxPolls: 4});

    expect(writeContract).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
    expect(executeSell).not.toHaveBeenCalled();
  });

  it('keeps watching after reporting what it would do', async () => {
    const {monitor, readState} = harness({
      ticks: [223000, 223000, 223000, 223000],
      dryRun: true,
    });

    await monitor.run({maxPolls: 4});

    expect(readState).toHaveBeenCalledTimes(4);
  });
});
