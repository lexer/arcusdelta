/**
 * Assembles a PnL report from chain data alone.
 *
 * There is no local ledger on purpose. The wallet is used outside this bot, so
 * any bot-kept record would drift the moment a trade happened elsewhere —
 * which has already occurred. Reconstructing from logs cannot drift.
 *
 * Limitation worth knowing: the RPC only serves historical *state* for roughly
 * a thousand blocks, so a position that closed long ago cannot have its exit
 * price read back. Fees are therefore split out only for positions still open.
 * Realized PnL is unaffected — it comes from logs, which are always available.
 */

import {getSwapShellTradeHistory} from '@arcus-xyz/arcus-spot-sdk';
import {getAddress, parseAbiItem, type Hex, type PublicClient} from 'viem';
import type {Logger} from '../logging/logger.js';
import type {TokenMeta} from '../uniswap/depositService.js';
import {getV3Deployment} from '../uniswap/deployments.js';
import {ERC20_ABI} from '../uniswap/erc20.js';
import type {FeeReader} from '../uniswap/feeReader.js';
import {getAmountsForLiquidity} from '../uniswap/liquidityMath.js';
import {isToken0, type PoolIdentity} from '../uniswap/poolAddress.js';
import type {PoolReader} from '../uniswap/poolReader.js';
import type {OwnedPosition, PositionReader} from '../uniswap/positionReader.js';
import {getSqrtRatioAtTick} from '../uniswap/tickMath.js';
import {
  computePnl,
  poolPriceUsdgPerStock,
  type PnlBreakdown,
} from './pnlCalculator.js';

/** Blocks per eth_getLogs request; providers cap the range they will serve. */
const LOG_CHUNK_BLOCKS = 50_000n;

const INCREASE_LIQUIDITY_EVENT = parseAbiItem(
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
);

export interface ArcusTrade {
  readonly blockNumber: bigint;
  readonly txHash: Hex;
  readonly direction: 'buy' | 'sell';
  readonly usdgAtoms: bigint;
  readonly stockAtoms: bigint;
  /** Realized USDG per whole stock token on this fill. */
  readonly price: number;
}

export interface PositionValuation {
  readonly position: OwnedPosition;
  readonly principalUsdg: bigint;
  readonly principalStock: bigint;
  readonly fees0: bigint;
  readonly fees1: bigint;
  /** USDG taken from the wallet to fund this position, from its mint event. */
  readonly depositedUsdg: bigint;
}

export interface PnlReport {
  readonly walletAddress: Hex;
  readonly scannedFromBlock: bigint;
  readonly scannedToBlock: bigint;
  readonly trades: readonly ArcusTrade[];
  readonly positions: readonly PositionValuation[];
  readonly stockBalance: bigint;
  readonly poolTick: number;
  readonly priceUsdgPerStock: number;
  readonly breakdown: PnlBreakdown;
}

export interface PnlReporterOptions {
  readonly publicClient: PublicClient;
  readonly poolReader: PoolReader;
  readonly positionReader: PositionReader;
  readonly feeReader: FeeReader;
  readonly logger: Logger;
  readonly chainId: number;
  readonly pool: PoolIdentity;
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
}

export class PnlReporter {
  constructor(private readonly options: PnlReporterOptions) {}

  async report(owner: Hex, fromBlock: bigint): Promise<PnlReport> {
    const {publicClient, poolReader, positionReader, logger, pool} =
      this.options;

    const toBlock = await publicClient.getBlockNumber();
    logger.info(
      {owner, fromBlock: fromBlock.toString(), toBlock: toBlock.toString()},
      'building pnl report',
    );

    const [trades, poolState, positions, stockBalance] = await Promise.all([
      this.loadTrades(owner, fromBlock, toBlock),
      poolReader.readState(pool),
      positionReader.discover(pool, owner),
      publicClient.readContract({
        address: this.options.stock.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      }),
    ]);

    const priceUsdgPerStock = poolPriceUsdgPerStock(
      poolState.sqrtPriceX96,
      this.options.usdg.decimals,
      this.options.stock.decimals,
    );

    const valuations = await Promise.all(
      positions.map(position =>
        this.valuePosition(
          position,
          poolState.sqrtPriceX96,
          fromBlock,
          toBlock,
        ),
      ),
    );

    let usdgSpent = 0n;
    let usdgReceived = 0n;
    for (const trade of trades) {
      if (trade.direction === 'buy') usdgSpent += trade.usdgAtoms;
      else usdgReceived += trade.usdgAtoms;
    }

    const totals = valuations.reduce(
      (acc, v) => ({
        lpUsdg: acc.lpUsdg + v.principalUsdg,
        lpStock: acc.lpStock + v.principalStock,
        fees0: acc.fees0 + v.fees0,
        fees1: acc.fees1 + v.fees1,
        usdgDepositedToLp: acc.usdgDepositedToLp + v.depositedUsdg,
      }),
      {
        lpUsdg: 0n,
        lpStock: 0n,
        fees0: 0n,
        fees1: 0n,
        usdgDepositedToLp: 0n,
      },
    );

    const breakdown = computePnl({
      usdgSpent,
      usdgReceived,
      stockBalance,
      ...totals,
      usdgDecimals: this.options.usdg.decimals,
      stockDecimals: this.options.stock.decimals,
      priceUsdgPerStock,
    });

    logger.info(
      {
        trades: trades.length,
        positions: valuations.length,
        usdgSpent: usdgSpent.toString(),
        usdgReceived: usdgReceived.toString(),
        netUsdg: breakdown.netUsdg,
        feesUsdg: breakdown.feesUsdg,
      },
      'pnl report built',
    );

    return {
      walletAddress: owner,
      scannedFromBlock: fromBlock,
      scannedToBlock: toBlock,
      trades,
      positions: valuations,
      stockBalance,
      poolTick: poolState.tick,
      priceUsdgPerStock,
      breakdown,
    };
  }

  /**
   * Runs `fetch` over `[fromBlock, toBlock]` in bounded chunks, retrying each
   * chunk a few times and skipping (with a warning) one that never succeeds.
   * Shared by the Arcus trade scan and the per-position mint-event lookup.
   */
  private async scanChunked<T>(
    fromBlock: bigint,
    toBlock: bigint,
    fetch: (start: bigint, end: bigint) => Promise<T[]>,
    describe: string,
  ): Promise<T[]> {
    const {logger} = this.options;
    const results: T[] = [];

    for (let end = toBlock; end > fromBlock; end -= LOG_CHUNK_BLOCKS) {
      const start =
        end > fromBlock + LOG_CHUNK_BLOCKS ? end - LOG_CHUNK_BLOCKS : fromBlock;
      try {
        results.push(...(await fetch(start, end)));
      } catch (error) {
        logger.warn(
          {
            fromBlock: start.toString(),
            toBlock: end.toString(),
            error: String(error),
            scan: describe,
          },
          'log range rejected, skipping chunk',
        );
      }
    }
    return results;
  }

  /** Arcus fills between USDG and the stock token, in either direction. */
  private async loadTrades(
    owner: Hex,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<ArcusTrade[]> {
    const {publicClient, usdg, stock} = this.options;

    const entries = await this.scanChunked(
      fromBlock,
      toBlock,
      (start, end) =>
        getSwapShellTradeHistory({
          publicClient,
          chainId: this.options.chainId,
          taker: owner,
          fromBlock: start,
          toBlock: end,
        }),
      'arcus trades',
    );

    const trades: ArcusTrade[] = [];
    for (const entry of entries) {
      if (!entry.args.success) continue;
      const tokenIn = getAddress(entry.args.tokenIn);
      const tokenOut = getAddress(entry.args.tokenOut);

      const isBuy = tokenIn === usdg.address && tokenOut === stock.address;
      const isSell = tokenIn === stock.address && tokenOut === usdg.address;
      if (!isBuy && !isSell) continue;

      const usdgAtoms = isBuy ? entry.args.amountIn : entry.args.amountOut;
      const stockAtoms = isBuy ? entry.args.amountOut : entry.args.amountIn;
      const stockWhole = Number(stockAtoms) / 10 ** stock.decimals;

      trades.push({
        blockNumber: entry.blockNumber ?? 0n,
        txHash: entry.transactionHash ?? '0x',
        direction: isBuy ? 'buy' : 'sell',
        usdgAtoms,
        stockAtoms,
        price:
          stockWhole === 0
            ? 0
            : Number(usdgAtoms) / 10 ** usdg.decimals / stockWhole,
      });
    }

    trades.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
    return trades;
  }

  /** Principal at the current price, plus fees accrued but not collected. */
  private async valuePosition(
    position: OwnedPosition,
    sqrtPriceX96: bigint,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PositionValuation> {
    const {amount0, amount1} = getAmountsForLiquidity(
      sqrtPriceX96,
      getSqrtRatioAtTick(position.tickLower),
      getSqrtRatioAtTick(position.tickUpper),
      position.liquidity,
    );
    const {fees0, fees1} = await this.options.feeReader.read(
      this.options.pool,
      position,
    );

    return {
      position,
      principalUsdg: amount0,
      principalStock: amount1,
      fees0,
      fees1,
      depositedUsdg: await this.readDepositedUsdg(position, fromBlock, toBlock),
    };
  }

  /**
   * USDG the wallet paid into a position, read from its mint's
   * `IncreaseLiquidity` event — the first one ever emitted for this tokenId.
   *
   * Without this the position's USDG side looks like profit from nowhere: it
   * comes straight from the wallet and never appears in an Arcus trade.
   */
  private async readDepositedUsdg(
    position: OwnedPosition,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<bigint> {
    const {logger, chainId, pool} = this.options;
    const positionManager = getV3Deployment(chainId).positionManager;

    const logs = await this.scanChunked(
      fromBlock,
      toBlock,
      (start, end) =>
        this.options.publicClient.getLogs({
          address: positionManager,
          event: INCREASE_LIQUIDITY_EVENT,
          args: {tokenId: position.tokenId},
          fromBlock: start,
          toBlock: end,
        }),
      `mint event for token ${position.tokenId}`,
    );

    if (logs.length === 0) {
      logger.warn(
        {tokenId: position.tokenId.toString()},
        'no mint event found in the scanned range; deposited USDG will be understated',
      );
      return 0n;
    }

    // The mint is the earliest IncreaseLiquidity this tokenId ever emitted;
    // any later ones would be a subsequent top-up, not the original deposit.
    logs.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
    const mint = logs[0]!;
    const deposited = isToken0(pool, this.options.usdg.address)
      ? mint.args.amount0!
      : mint.args.amount1!;

    logger.info(
      {
        tokenId: position.tokenId.toString(),
        mintTxHash: mint.transactionHash,
        depositedUsdg: deposited.toString(),
      },
      'read deposited usdg from mint event',
    );
    return deposited;
  }
}
