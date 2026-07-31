import {beforeEach, describe, expect, it, vi} from 'vitest';
import {pino} from 'pino';
import type {TokenMeta} from '../uniswap/depositService.js';
import {createPoolKey} from '../uniswap/poolKey.js';
import type {PoolState} from '../uniswap/poolReader.js';
import type {OwnedPosition} from '../uniswap/positionReader.js';
import {getSqrtRatioAtTick} from '../uniswap/tickMath.js';
import {PnlReporter, type PnlReporterOptions} from './pnlReporter.js';

const {tradeHistoryMock} = vi.hoisted(() => ({tradeHistoryMock: vi.fn()}));

vi.mock('@arcus-xyz/arcus-spot-sdk', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@arcus-xyz/arcus-spot-sdk')>();
  return {...actual, getSwapShellTradeHistory: tradeHistoryMock};
});

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

const UNRELATED = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';

const POSITION: OwnedPosition = {
  tokenId: 422596n,
  tickLower: 223080,
  tickUpper: 223740,
  liquidity: 60_210_398_382_745n,
  mintTxHash: '0xmint',
};

/** The live buy: 10 USDG for ~0.0504 NVDA. */
function buyLog() {
  return {
    blockNumber: 23925409n,
    transactionHash: '0xbuy',
    args: {
      tokenIn: USDG.address,
      tokenOut: NVDA.address,
      amountIn: 10_000_000n,
      amountOut: 50_354_603_838_217_920n,
      success: true,
    },
  };
}

/** The live sell: ~0.0755 NVDA for ~14.99 USDG. */
function sellLog() {
  return {
    blockNumber: 23925759n,
    transactionHash: '0xsell',
    args: {
      tokenIn: NVDA.address,
      tokenOut: USDG.address,
      amountIn: 75_533_445_771_557_684n,
      amountOut: 14_989_524n,
      success: true,
    },
  };
}

interface HarnessOptions {
  logs?: unknown[];
  positions?: OwnedPosition[];
  stockBalance?: bigint;
}

function harness(options: HarnessOptions = {}) {
  tradeHistoryMock.mockReset();
  tradeHistoryMock.mockResolvedValue([]);
  tradeHistoryMock.mockResolvedValueOnce(options.logs ?? []);

  const readContract = vi.fn(({functionName}) => {
    if (functionName === 'balanceOf') {
      return Promise.resolve(options.stockBalance ?? 0n);
    }
    if (functionName === 'getPositionInfo') {
      return Promise.resolve([
        60_210_398_382_745n,
        7_623_132_171_635_300_410_892_319_181_130n,
        38_951_241_200_658_619_592_182_522_523_042_443_779_097n,
      ]);
    }
    if (functionName === 'getFeeGrowthInside') {
      return Promise.resolve([
        7_685_209_671_248_051_714_120_297_456_278n,
        39_355_508_630_248_240_174_357_965_892_606_147_015_148n,
      ]);
    }
    return Promise.reject(new Error(`unexpected ${functionName}`));
  });

  const publicClient = {
    getBlockNumber: vi.fn().mockResolvedValue(40_000n),
    readContract,
    getTransactionReceipt: vi.fn().mockResolvedValue({
      logs: [
        {
          address: USDG.address,
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            `0x${OWNER.slice(2).toLowerCase().padStart(64, '0')}`,
            `0x${'11'.repeat(32)}`,
          ],
          data: `0x${13_000_000n.toString(16).padStart(64, '0')}`,
        },
      ],
    }),
  };

  const readState = vi.fn().mockResolvedValue({
    poolId: `0x${'3b'.repeat(32)}`,
    sqrtPriceX96: getSqrtRatioAtTick(223440),
    tick: 223440,
    lpFee: 3000,
    liquidity: 817_184_618_165_972_105n,
  } satisfies PoolState);

  const reporterOptions: PnlReporterOptions = {
    publicClient: publicClient as never,
    poolReader: {readState},
    positionReader: {
      discover: vi.fn().mockResolvedValue(options.positions ?? []),
      read: vi.fn(),
    },
    logger: pino({level: 'silent'}),
    chainId: 4663,
    poolKey: createPoolKey(USDG.address, NVDA.address, 3000, 60),
    usdg: USDG,
    stock: NVDA,
  };

  return {reporter: new PnlReporter(reporterOptions)};
}

beforeEach(() => {
  tradeHistoryMock.mockReset();
});

describe('trade reconstruction', () => {
  it('classifies buys and sells by direction', async () => {
    const {reporter} = harness({logs: [buyLog(), sellLog()]});

    const report = await reporter.report(OWNER, 0n);

    expect(report.trades).toHaveLength(2);
    expect(report.trades[0]?.direction).toBe('buy');
    expect(report.trades[1]?.direction).toBe('sell');
  });

  it('orders trades oldest first', async () => {
    const {reporter} = harness({logs: [sellLog(), buyLog()]});

    const report = await reporter.report(OWNER, 0n);

    expect(report.trades[0]?.blockNumber).toBe(23925409n);
  });

  it('computes the realized price of each fill', async () => {
    const {reporter} = harness({logs: [buyLog()]});

    const report = await reporter.report(OWNER, 0n);

    // 10 USDG for 0.0503546 NVDA is about 198.6.
    expect(report.trades[0]?.price).toBeCloseTo(198.59, 1);
  });

  it('ignores swaps involving an unrelated token', async () => {
    const {reporter} = harness({
      logs: [
        {
          blockNumber: 1n,
          transactionHash: '0xother',
          args: {
            tokenIn: USDG.address,
            tokenOut: UNRELATED,
            amountIn: 20_000_000_000n,
            amountOut: 64_618_267_584_246_066_362n,
            success: true,
          },
        },
      ],
    });

    const report = await reporter.report(OWNER, 0n);

    expect(report.trades).toEqual([]);
  });

  it('ignores swaps that failed on chain', async () => {
    const failed = buyLog();
    failed.args.success = false;
    const {reporter} = harness({logs: [failed]});

    const report = await reporter.report(OWNER, 0n);

    expect(report.trades).toEqual([]);
  });

  it('nets a completed round trip into realized profit', async () => {
    const {reporter} = harness({logs: [buyLog(), sellLog()]});

    const report = await reporter.report(OWNER, 0n);

    expect(report.breakdown.capitalInUsdg).toBeCloseTo(10, 6);
    expect(report.breakdown.capitalOutUsdg).toBeCloseTo(14.989524, 6);
  });
});

describe('position valuation', () => {
  it('reports principal and uncollected fees', async () => {
    const {reporter} = harness({positions: [POSITION]});

    const report = await reporter.report(OWNER, 0n);

    expect(report.positions).toHaveLength(1);
    expect(report.positions[0]?.fees0).toBe(10_984n);
    expect(report.positions[0]?.fees1).toBe(71_532_072_640_175n);
    expect(report.positions[0]?.principalUsdg).toBeGreaterThan(0n);
    expect(report.positions[0]?.principalStock).toBeGreaterThan(0n);
  });

  it('counts fees toward the net figure', async () => {
    const withPosition = await harness({positions: [POSITION]}).reporter.report(
      OWNER,
      0n,
    );
    const without = await harness({positions: []}).reporter.report(OWNER, 0n);

    expect(withPosition.breakdown.feesUsdg).toBeCloseTo(0.0252, 3);
    expect(without.breakdown.feesUsdg).toBe(0);
  });

  it('treats an open position as value, not loss', async () => {
    const {reporter} = harness({logs: [buyLog()], positions: [POSITION]});

    const report = await reporter.report(OWNER, 0n);

    expect(report.breakdown.openValueUsdg).toBeGreaterThan(0);
  });

  it('counts the USDG that funded the position as capital in', async () => {
    // Read from the mint receipt, not from any Arcus trade.
    const {reporter} = harness({logs: [buyLog()], positions: [POSITION]});

    const report = await reporter.report(OWNER, 0n);

    expect(report.positions[0]?.depositedUsdg).toBe(13_000_000n);
    // 10 USDG of buys plus 13 USDG deposited.
    expect(report.breakdown.capitalInUsdg).toBeCloseTo(23, 6);
  });
});

describe('report shape', () => {
  it('records the scanned window', async () => {
    const {reporter} = harness();

    const report = await reporter.report(OWNER, 100n);

    expect(report.scannedFromBlock).toBe(100n);
    expect(report.scannedToBlock).toBe(40_000n);
  });

  it('marks value at the pool price', async () => {
    const {reporter} = harness();

    const report = await reporter.report(OWNER, 0n);

    expect(report.poolTick).toBe(223440);
    expect(report.priceUsdgPerStock).toBeGreaterThan(190);
  });

  it('handles a wallet with no activity at all', async () => {
    const {reporter} = harness();

    const report = await reporter.report(OWNER, 0n);

    expect(report.trades).toEqual([]);
    expect(report.positions).toEqual([]);
    expect(report.breakdown.netUsdg).toBe(0);
    expect(report.breakdown.returnFraction).toBe(0);
  });
});
