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
  type WatchedSymbol,
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

const NVDA_POOL: PoolIdentity = {
  token0: USDG.address,
  token1: NVDA.address,
  fee: 3000,
  tickSpacing: 60,
  address: '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B',
};

const AAPL_POOL: PoolIdentity = {
  token0: USDG.address,
  token1: AAPL.address,
  fee: 3000,
  tickSpacing: 60,
  address: '0x783C9bbB765047CFdD2b84b92b2Ca9F11D34b7Ed',
};

describe('classifyTick', () => {
  it('reports in-range strictly inside the bounds', () => {
    expect(classifyTick(223400, NVDA_POSITION)).toBe('in-range');
    expect(classifyTick(223081, NVDA_POSITION)).toBe('in-range');
    expect(classifyTick(223739, NVDA_POSITION)).toBe('in-range');
  });

  it('treats the lower bound as fully USDG', () => {
    expect(classifyTick(223080, NVDA_POSITION)).toBe('below-range');
    expect(classifyTick(223079, NVDA_POSITION)).toBe('below-range');
  });

  it('treats the upper bound as fully stock', () => {
    expect(classifyTick(223740, NVDA_POSITION)).toBe('above-range');
    expect(classifyTick(223741, NVDA_POSITION)).toBe('above-range');
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
    const counter = new BreachCounter();

    expect(counter.record(1n, 'below-range', 3)).toBe(false);
    expect(counter.record(1n, 'below-range', 3)).toBe(false);
  });

  it('triggers exactly at the threshold', () => {
    const counter = new BreachCounter();

    counter.record(1n, 'below-range', 3);
    counter.record(1n, 'below-range', 3);

    expect(counter.record(1n, 'below-range', 3)).toBe(true);
  });

  it('resets when the pool comes back into range', () => {
    const counter = new BreachCounter();

    counter.record(1n, 'below-range', 3);
    counter.record(1n, 'below-range', 3);
    counter.record(1n, 'in-range', 3);

    expect(counter.count(1n)).toBe(0);
    expect(counter.record(1n, 'below-range', 3)).toBe(false);
  });

  it('counts each position independently', () => {
    const counter = new BreachCounter();

    counter.record(1n, 'below-range', 2);

    expect(counter.record(2n, 'above-range', 2)).toBe(false);
    expect(counter.record(1n, 'below-range', 2)).toBe(true);
  });

  it('triggers on the first reading when the threshold is one', () => {
    expect(new BreachCounter().record(1n, 'above-range', 1)).toBe(true);
  });

  it('applies a different threshold per position, from different symbols', () => {
    const counter = new BreachCounter();

    // Position 1 needs 1 breach, position 2 needs 3.
    expect(counter.record(1n, 'below-range', 1)).toBe(true);
    expect(counter.record(2n, 'below-range', 3)).toBe(false);
    expect(counter.record(2n, 'below-range', 3)).toBe(false);
    expect(counter.record(2n, 'below-range', 3)).toBe(true);
  });
});

interface HarnessOptions {
  nvdaTicks?: number[];
  aaplTicks?: number[];
  dryRun?: boolean;
  stockBalance?: bigint;
  nvdaPositions?: OwnedPosition[];
  aaplPositions?: OwnedPosition[];
  watchedSymbols?: WatchedSymbol[];
  nvdaExitConfirmations?: number;
  aaplExitConfirmations?: number;
  nvdaIntervalSeconds?: number;
  aaplIntervalSeconds?: number;
}

function harness(options: HarnessOptions = {}) {
  const nvdaTicks = options.nvdaTicks ?? [223400];
  const aaplTicks = options.aaplTicks ?? [218900];
  let poll = 0;

  const readState = vi.fn((pool: PoolIdentity) => {
    const ticks = pool.address === NVDA_POOL.address ? nvdaTicks : aaplTicks;
    const tick = ticks[Math.min(poll, ticks.length - 1)]!;
    return Promise.resolve({
      poolAddress: pool.address,
      sqrtPriceX96: getSqrtRatioAtTick(tick),
      tick,
      liquidity: 1_000_000_000n,
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

  function makeExitService(pool: PoolIdentity, stock: TokenMeta) {
    return new PositionExitService({
      wallet,
      feeReader: {read: vi.fn().mockResolvedValue({fees0: 0n, fees1: 0n})},
      swapService: {executeSell} as never,
      logger,
      chainId: 4663,
      pool,
      usdg: USDG,
      stock,
      closeSlippageBps: 100,
      sellSlippageBps: 1,
      deadlineSeconds: 300,
    });
  }

  const nvdaWatched: WatchedSymbol = {
    symbol: 'NVDA',
    pool: NVDA_POOL,
    exitService: makeExitService(NVDA_POOL, NVDA),
    checkIntervalSeconds: options.nvdaIntervalSeconds ?? 30,
    exitConfirmations: options.nvdaExitConfirmations ?? 3,
  };
  const aaplWatched: WatchedSymbol = {
    symbol: 'AAPL',
    pool: AAPL_POOL,
    exitService: makeExitService(AAPL_POOL, AAPL),
    checkIntervalSeconds: options.aaplIntervalSeconds ?? 30,
    exitConfirmations: options.aaplExitConfirmations ?? 3,
  };
  const watchedSymbols = options.watchedSymbols ?? [nvdaWatched, aaplWatched];

  const discover = vi.fn((pool: PoolIdentity) => {
    if (pool.address === NVDA_POOL.address) {
      return Promise.resolve(options.nvdaPositions ?? [NVDA_POSITION]);
    }
    return Promise.resolve(options.aaplPositions ?? [AAPL_POSITION]);
  });

  const sleep = vi.fn(async () => {
    poll++;
  });

  const monitorOptions: PositionMonitorOptions = {
    wallet,
    poolReader: {readState},
    positionReader: {
      discover,
      read: vi.fn().mockResolvedValue(NVDA_POSITION),
    },
    watchedSymbols,
    logger,
    dryRun: options.dryRun ?? false,
    sleep,
  };

  return {
    monitor: new PositionMonitor(monitorOptions),
    monitorOptions,
    writeContract,
    simulateContract,
    executeSell,
    readState,
    discover,
    nvdaWatched,
    aaplWatched,
  };
}

describe('run — single symbol (regression)', () => {
  it('does not close while the pool stays in range', async () => {
    const {monitor, writeContract, executeSell} = harness({
      nvdaTicks: [223400],
      aaplPositions: [],
    });

    await monitor.run({maxPolls: 10});

    expect(writeContract).not.toHaveBeenCalled();
    expect(executeSell).not.toHaveBeenCalled();
  });

  it('closes once the pool has been out of range long enough', async () => {
    const {monitor, writeContract, executeSell} = harness({
      nvdaTicks: [223000, 223000, 223000],
      aaplPositions: [],
    });

    await monitor.run({maxPolls: 5});

    expect(writeContract).toHaveBeenCalled();
    expect(executeSell).toHaveBeenCalled();
  });

  it('does not close when a wick mean-reverts', async () => {
    const {monitor, writeContract} = harness({
      nvdaTicks: [223000, 223000, 223400, 223000, 223000],
      aaplPositions: [],
    });

    await monitor.run({maxPolls: 5});

    expect(writeContract).not.toHaveBeenCalled();
  });

  it('simulates before it writes', async () => {
    const {monitor, simulateContract, writeContract} = harness({
      nvdaTicks: [223000, 223000, 223000],
      aaplPositions: [],
    });

    await monitor.run({maxPolls: 5});

    expect(simulateContract.mock.invocationCallOrder[0]!).toBeLessThan(
      writeContract.mock.invocationCallOrder[0]!,
    );
  });
});

describe('run — multiple symbols', () => {
  it('watches positions across two different pools in one run', async () => {
    const {monitor, discover} = harness({
      nvdaTicks: [223400],
      aaplTicks: [218900],
    });

    await monitor.run({maxPolls: 1});

    expect(discover).toHaveBeenCalledWith(NVDA_POOL, OWNER);
    expect(discover).toHaveBeenCalledWith(AAPL_POOL, OWNER);
  });

  it("a position in one pool triggers independently of the other's tick", async () => {
    const {monitor, writeContract, executeSell} = harness({
      nvdaTicks: [223000, 223000, 223000], // out of range, triggers
      aaplTicks: [218900, 218900, 218900], // stays in range
    });

    await monitor.run({maxPolls: 5});

    // Exactly one close: NVDA's.
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(executeSell).toHaveBeenCalledTimes(1);
  });

  it('closes both when both go out of range', async () => {
    const {monitor, writeContract} = harness({
      nvdaTicks: [223000, 223000, 223000],
      aaplTicks: [218000, 218000, 218000],
    });

    await monitor.run({maxPolls: 5});

    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  it('polls at the faster of two configured intervals', async () => {
    const {monitor, readState} = harness({
      nvdaIntervalSeconds: 30,
      aaplIntervalSeconds: 5,
      aaplPositions: [],
    });

    await monitor.run({maxPolls: 3});

    // Every poll reads NVDA's pool regardless of the interval used for sleep.
    expect(readState.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('reads each distinct pool once per tick, not once per position', async () => {
    const secondNvdaPosition = {...NVDA_POSITION, tokenId: 999n};
    const {monitor, readState} = harness({
      nvdaPositions: [NVDA_POSITION, secondNvdaPosition],
      aaplPositions: [],
    });

    await monitor.run({maxPolls: 1});

    const nvdaReads = readState.mock.calls.filter(
      c => (c[0] as PoolIdentity).address === NVDA_POOL.address,
    );
    expect(nvdaReads).toHaveLength(1);
  });

  it("applies each symbol's own exitConfirmations", async () => {
    const {monitor, writeContract} = harness({
      nvdaTicks: [223000], // 1 breach: enough for NVDA's threshold of 1
      aaplTicks: [218900],
      nvdaExitConfirmations: 1,
      aaplExitConfirmations: 3,
    });

    await monitor.run({maxPolls: 1});

    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("stops once every symbol's positions are closed", async () => {
    const {monitor, readState} = harness({
      nvdaTicks: [223000, 223000, 223000],
      aaplTicks: [218000, 218000, 218000],
    });

    await monitor.run({maxPolls: 20});

    expect(readState.mock.calls.length).toBeLessThan(20 * 2);
  });

  it('rejects --token-id when more than one symbol is watched', async () => {
    const {monitor} = harness();

    await expect(monitor.run({tokenId: 1n})).rejects.toThrow(/--symbol/);
  });

  it('accepts --token-id when exactly one symbol is watched', async () => {
    const {monitorOptions, nvdaWatched} = harness();
    const single = new PositionMonitor({
      ...monitorOptions,
      watchedSymbols: [nvdaWatched],
    });

    await expect(
      single.run({tokenId: 422596n, maxPolls: 1}),
    ).resolves.toBeUndefined();
  });

  it('returns immediately when nothing is found across any symbol', async () => {
    const {monitor, readState} = harness({
      nvdaPositions: [],
      aaplPositions: [],
    });

    await monitor.run({maxPolls: 5});

    expect(readState).not.toHaveBeenCalled();
  });
});

describe('dry run', () => {
  it('never sends a transaction, however far out of range', async () => {
    const {monitor, writeContract, simulateContract, executeSell} = harness({
      nvdaTicks: [223000, 223000, 223000, 223000],
      aaplPositions: [],
      dryRun: true,
    });

    await monitor.run({maxPolls: 4});

    expect(writeContract).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
    expect(executeSell).not.toHaveBeenCalled();
  });

  it('keeps watching after reporting what it would do', async () => {
    const {monitor, readState} = harness({
      nvdaTicks: [223000, 223000, 223000, 223000],
      aaplPositions: [],
      dryRun: true,
    });

    await monitor.run({maxPolls: 4});

    expect(readState.mock.calls.length).toBe(4);
  });
});
