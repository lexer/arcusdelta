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
import {getAddress, type Hex, type PublicClient} from 'viem';
import type {Logger} from '../logging/logger.js';
import type {TokenMeta} from '../uniswap/depositService.js';
import {getV4Deployment} from '../uniswap/deployments.js';
import {getAmountsForLiquidity} from '../uniswap/liquidityMath.js';
import {ERC20_ABI} from '../uniswap/permit2.js';
import {toPoolId, type PoolKey} from '../uniswap/poolKey.js';
import type {PoolReader} from '../uniswap/poolReader.js';
import type {OwnedPosition, PositionReader} from '../uniswap/positionReader.js';
import {getSqrtRatioAtTick} from '../uniswap/tickMath.js';
import {
  accruedFees,
  computePnl,
  poolPriceUsdgPerStock,
  type PnlBreakdown,
} from './pnlCalculator.js';

/** Blocks per eth_getLogs request; providers cap the range they will serve. */
const LOG_CHUNK_BLOCKS = 50_000n;

export const FEE_STATE_ABI = [
  {
    type: 'function',
    name: 'getPositionInfo',
    stateMutability: 'view',
    inputs: [
      {name: 'poolId', type: 'bytes32'},
      {name: 'owner', type: 'address'},
      {name: 'tickLower', type: 'int24'},
      {name: 'tickUpper', type: 'int24'},
      {name: 'salt', type: 'bytes32'},
    ],
    outputs: [
      {name: 'liquidity', type: 'uint128'},
      {name: 'feeGrowthInside0LastX128', type: 'uint256'},
      {name: 'feeGrowthInside1LastX128', type: 'uint256'},
    ],
  },
  {
    type: 'function',
    name: 'getFeeGrowthInside',
    stateMutability: 'view',
    inputs: [
      {name: 'poolId', type: 'bytes32'},
      {name: 'tickLower', type: 'int24'},
      {name: 'tickUpper', type: 'int24'},
    ],
    outputs: [
      {name: 'feeGrowthInside0X128', type: 'uint256'},
      {name: 'feeGrowthInside1X128', type: 'uint256'},
    ],
  },
] as const;

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
  /** USDG taken from the wallet to fund this position, from the mint receipt. */
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
  readonly logger: Logger;
  readonly chainId: number;
  readonly poolKey: PoolKey;
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
}

export class PnlReporter {
  constructor(private readonly options: PnlReporterOptions) {}

  async report(owner: Hex, fromBlock: bigint): Promise<PnlReport> {
    const {publicClient, poolReader, positionReader, logger, poolKey} =
      this.options;

    const toBlock = await publicClient.getBlockNumber();
    logger.info(
      {owner, fromBlock: fromBlock.toString(), toBlock: toBlock.toString()},
      'building pnl report',
    );

    const [trades, poolState, positions, stockBalance] = await Promise.all([
      this.loadTrades(owner, fromBlock, toBlock),
      poolReader.readState(poolKey),
      positionReader.discover(poolKey, owner),
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
        this.valuePosition(position, poolState.sqrtPriceX96, owner),
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

  /** Arcus fills between USDG and the stock token, in either direction. */
  private async loadTrades(
    owner: Hex,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<ArcusTrade[]> {
    const {publicClient, logger, usdg, stock} = this.options;
    const trades: ArcusTrade[] = [];

    for (let end = toBlock; end > fromBlock; end -= LOG_CHUNK_BLOCKS) {
      const start =
        end > fromBlock + LOG_CHUNK_BLOCKS ? end - LOG_CHUNK_BLOCKS : fromBlock;
      let logs;
      try {
        logs = await getSwapShellTradeHistory({
          publicClient,
          chainId: this.options.chainId,
          taker: owner,
          fromBlock: start,
          toBlock: end,
        });
      } catch (error) {
        logger.warn(
          {
            fromBlock: start.toString(),
            toBlock: end.toString(),
            error: String(error),
          },
          'trade log range rejected, skipping chunk',
        );
        continue;
      }

      for (const entry of logs) {
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
    }

    trades.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
    return trades;
  }

  /** Principal at the current price, plus fees accrued but not collected. */
  private async valuePosition(
    position: OwnedPosition,
    sqrtPriceX96: bigint,
    owner: Hex,
  ): Promise<PositionValuation> {
    const {publicClient, chainId, poolKey} = this.options;
    const deployment = getV4Deployment(chainId);
    const poolId = toPoolId(poolKey);
    const salt = `0x${position.tokenId.toString(16).padStart(64, '0')}` as Hex;

    const {amount0, amount1} = getAmountsForLiquidity(
      sqrtPriceX96,
      getSqrtRatioAtTick(position.tickLower),
      getSqrtRatioAtTick(position.tickUpper),
      position.liquidity,
    );

    // PoolManager sees PositionManager as the owner; the NFT id is the salt.
    const [info, growth] = await Promise.all([
      publicClient.readContract({
        address: deployment.stateView,
        abi: FEE_STATE_ABI,
        functionName: 'getPositionInfo',
        args: [
          poolId,
          deployment.positionManager,
          position.tickLower,
          position.tickUpper,
          salt,
        ],
      }),
      publicClient.readContract({
        address: deployment.stateView,
        abi: FEE_STATE_ABI,
        functionName: 'getFeeGrowthInside',
        args: [poolId, position.tickLower, position.tickUpper],
      }),
    ]);

    const [liquidity, last0, last1] = info;
    const [inside0, inside1] = growth;
    const {fees0, fees1} = accruedFees(
      BigInt(liquidity),
      inside0,
      inside1,
      last0,
      last1,
    );

    return {
      position,
      principalUsdg: amount0,
      principalStock: amount1,
      fees0,
      fees1,
      depositedUsdg: await this.readDepositedUsdg(position, owner),
    };
  }

  /**
   * USDG the wallet paid into a position, summed from the mint transaction's
   * ERC20 transfers.
   *
   * Without this the position's USDG side looks like profit from nowhere: it
   * comes straight from the wallet and never appears in an Arcus trade.
   */
  private async readDepositedUsdg(
    position: OwnedPosition,
    owner: Hex,
  ): Promise<bigint> {
    const {publicClient, logger, usdg} = this.options;
    if (!position.mintTxHash) {
      logger.warn(
        {tokenId: position.tokenId.toString()},
        'no mint transaction known; deposited USDG will be understated',
      );
      return 0n;
    }

    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: position.mintTxHash,
      });
      let deposited = 0n;
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== usdg.address) continue;
        if (log.topics[0] !== TRANSFER_TOPIC) continue;
        const from = topicToAddress(log.topics[1]);
        if (!from || from !== getAddress(owner)) continue;
        deposited += BigInt(log.data);
      }
      logger.info(
        {
          tokenId: position.tokenId.toString(),
          mintTxHash: position.mintTxHash,
          depositedUsdg: deposited.toString(),
        },
        'read deposited usdg from mint receipt',
      );
      return deposited;
    } catch (error) {
      logger.warn(
        {tokenId: position.tokenId.toString(), error: String(error)},
        'could not read mint receipt; deposited USDG will be understated',
      );
      return 0n;
    }
  }
}

/** keccak256('Transfer(address,address,uint256)') */
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicToAddress(topic: Hex | undefined): Hex | undefined {
  if (!topic || topic.length !== 66) return undefined;
  return getAddress(`0x${topic.slice(26)}`);
}
