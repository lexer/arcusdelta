/**
 * Exits a liquidity position: burn it, collect principal and fees, then sell
 * the stock token back to USDG on Arcus.
 *
 * Shared by the automatic monitor and the manual `exit` command, so a hand-run
 * exit takes exactly the path the unattended one does.
 *
 * Planning is separated from execution: `plan` is read-only and reports what
 * would be withdrawn, `exit` spends.
 */

import {randomUUID} from 'node:crypto';
import type {Hex} from 'viem';
import type {SpotSwapService} from '../arcus/spotSwapService.js';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Logger} from '../logging/logger.js';
import {getV3Deployment} from './deployments.js';
import type {TokenMeta} from './depositService.js';
import {ERC20_ABI} from './erc20.js';
import type {FeeReader} from './feeReader.js';
import {getAmountsForLiquidity} from './liquidityMath.js';
import type {PoolIdentity} from './poolAddress.js';
import {calculateMinimums, closePosition} from './positionCloser.js';
import type {OwnedPosition} from './positionReader.js';
import {getSqrtRatioAtTick} from './tickMath.js';

export interface ExitPlan {
  readonly position: OwnedPosition;
  /** Principal the burn should return, at the current price. */
  readonly principalUsdg: bigint;
  readonly principalStock: bigint;
  /** Fees accrued and uncollected, returned by the same burn. */
  readonly fees0: bigint;
  readonly fees1: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
}

export interface ExitResult {
  readonly tokenId: bigint;
  readonly closeHash: Hex;
  /** Stock atoms sold afterwards; zero when the close returned none. */
  readonly stockSold: bigint;
  /** One hash per TWAP chunk; a single-element array when TWAP is off. */
  readonly saleTxHashes?: readonly Hex[];
  readonly usdgReceived?: string;
}

export interface PositionExitServiceOptions {
  readonly wallet: WalletProvider;
  readonly feeReader: FeeReader;
  readonly swapService: Pick<SpotSwapService, 'executeSell'>;
  readonly logger: Logger;
  readonly chainId: number;
  readonly pool: PoolIdentity;
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
  readonly closeSlippageBps: number;
  readonly sellSlippageBps: number;
  readonly deadlineSeconds: number;
  /** Split the post-close sell into this many chunks. 1 disables TWAP. */
  readonly twapChunks: number;
  readonly twapIntervalSeconds: number;
}

export class PositionExitService {
  constructor(private readonly options: PositionExitServiceOptions) {}

  get tokens(): {usdg: TokenMeta; stock: TokenMeta} {
    return {usdg: this.options.usdg, stock: this.options.stock};
  }

  get pool(): PoolIdentity {
    return this.options.pool;
  }

  /** Read-only. What the burn would return, principal and fees separately. */
  async plan(position: OwnedPosition, sqrtPriceX96: bigint): Promise<ExitPlan> {
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
    const {amount0Min, amount1Min} = calculateMinimums(
      position,
      sqrtPriceX96,
      this.options.closeSlippageBps,
    );

    return {
      position,
      principalUsdg: amount0,
      principalStock: amount1,
      fees0,
      fees1,
      amount0Min,
      amount1Min,
    };
  }

  /** Burns the position, then sells whatever stock token it returned. */
  async exit(
    plan: ExitPlan,
    tradeId: string = randomUUID(),
  ): Promise<ExitResult> {
    const {wallet, logger, chainId, stock} = this.options;
    const owner = wallet.getAccount().address;
    const log = logger.child({
      tradeId,
      tokenId: plan.position.tokenId.toString(),
    });

    const closeResult = await closePosition(
      {
        publicClient: wallet.getPublicClient(),
        walletClient: wallet.getWalletClient(),
        positionManager: getV3Deployment(chainId).positionManager,
        logger: log,
      },
      {
        tokenId: plan.position.tokenId,
        liquidity: plan.position.liquidity,
        amount0Min: plan.amount0Min,
        amount1Min: plan.amount1Min,
        recipient: owner,
      },
      this.options.deadlineSeconds,
    );
    log.info({hash: closeResult.hash}, 'position closed');

    // Sell whatever stock the wallet now holds: principal when the pool moved
    // up, fees alone when it moved down. Either way the rest state is USDG.
    const stockBalance = await wallet.getPublicClient().readContract({
      address: stock.address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });

    if (stockBalance === 0n) {
      log.info('no stock token to sell after close');
      return {
        tokenId: plan.position.tokenId,
        closeHash: closeResult.hash,
        stockSold: 0n,
      };
    }

    log.info(
      {stockBalance: stockBalance.toString(), symbol: stock.symbol},
      'selling stock token on arcus',
    );
    const sale = await this.options.swapService.executeSell({
      tradeId,
      sellToken: stock.address,
      sellAmountAtoms: stockBalance,
      slippageBps: this.options.sellSlippageBps,
      twapChunks: this.options.twapChunks,
      twapIntervalSeconds: this.options.twapIntervalSeconds,
    });
    log.info({txHashes: sale.txHashes}, 'exit complete');

    return {
      tokenId: plan.position.tokenId,
      closeHash: closeResult.hash,
      stockSold: stockBalance,
      saleTxHashes: sale.txHashes,
      usdgReceived: sale.buyAmount,
    };
  }
}
