/**
 * Opens a concentrated liquidity position from the wallet's stock-token
 * balance.
 *
 * The stock token is the fixed side: whatever the wallet holds is committed,
 * and the USDG the range requires is derived from it. Planning is separated
 * from execution so the operator can review real numbers before anything
 * moves — `plan()` is read-only, `execute()` spends.
 */

import {formatUnits, type Hex, type PublicClient} from 'viem';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Logger} from '../logging/logger.js';
import {getV4Deployment} from './deployments.js';
import {
  getAmountsForLiquidity,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
} from './liquidityMath.js';
import {ensureAllowances, ERC20_ABI} from './permit2.js';
import {createPoolKey, isCurrency0, type PoolKey} from './poolKey.js';
import type {PoolReader, PoolState} from './poolReader.js';
import {mintPosition, type MintResult} from './positionManager.js';
import {calculateRange} from './rangeCalculator.js';
import {getSqrtRatioAtTick} from './tickMath.js';

export class InsufficientBalanceError extends Error {
  constructor(
    readonly symbol: string,
    readonly required: bigint,
    readonly available: bigint,
    decimals: number,
  ) {
    super(
      `Need ${formatUnits(required, decimals)} ${symbol} for this position ` +
        `but the wallet holds ${formatUnits(available, decimals)} ${symbol}`,
    );
    this.name = 'InsufficientBalanceError';
  }
}

export interface TokenMeta {
  readonly address: Hex;
  readonly symbol: string;
  readonly decimals: number;
}

export interface DepositPlan {
  readonly poolKey: PoolKey;
  readonly poolId: Hex;
  readonly currentTick: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly stockAmount: bigint;
  readonly usdgAmount: bigint;
  readonly amount0Max: bigint;
  readonly amount1Max: bigint;
  readonly usdgBalance: bigint;
}

export interface DepositResult extends MintResult {
  readonly plan: DepositPlan;
  readonly approvalHashes: readonly Hex[];
}

export interface DepositServiceOptions {
  readonly wallet: WalletProvider;
  readonly poolReader: PoolReader;
  readonly logger: Logger;
  readonly chainId: number;
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
  readonly rangeDeviationPercent: number;
  readonly poolFee: number;
  readonly poolTickSpacing: number;
  readonly lpSlippageBps: number;
  readonly mintDeadlineSeconds: number;
}

export class DepositService {
  constructor(private readonly options: DepositServiceOptions) {}

  /** Token metadata resolved at construction, for display and formatting. */
  get tokens(): {usdg: TokenMeta; stock: TokenMeta} {
    return {usdg: this.options.usdg, stock: this.options.stock};
  }

  /** Read-only. Computes exactly what {@link execute} would do. */
  async plan(): Promise<DepositPlan> {
    const {wallet, poolReader, logger, usdg, stock} = this.options;
    const owner = wallet.getAccount().address;
    const client = wallet.getPublicClient();

    const poolKey = createPoolKey(
      usdg.address,
      stock.address,
      this.options.poolFee,
      this.options.poolTickSpacing,
    );

    const [poolState, stockBalance, usdgBalance] = await Promise.all([
      poolReader.readState(poolKey),
      readBalance(client, stock.address, owner),
      readBalance(client, usdg.address, owner),
    ]);

    logger.info(
      {
        poolId: poolState.poolId,
        tick: poolState.tick,
        lpFee: poolState.lpFee,
        poolLiquidity: poolState.liquidity.toString(),
        stockBalance: stockBalance.toString(),
        usdgBalance: usdgBalance.toString(),
      },
      'read pool and balances',
    );

    if (stockBalance === 0n) {
      throw new InsufficientBalanceError(stock.symbol, 1n, 0n, stock.decimals);
    }

    const {tickLower, tickUpper} = calculateRange(
      poolState.tick,
      this.options.rangeDeviationPercent,
      this.options.poolTickSpacing,
    );

    const plan = this.buildPlan(
      poolKey,
      poolState,
      tickLower,
      tickUpper,
      stockBalance,
      usdgBalance,
    );

    logger.info(
      {
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        liquidity: plan.liquidity.toString(),
        stockAmount: plan.stockAmount.toString(),
        usdgAmount: plan.usdgAmount.toString(),
        amount0Max: plan.amount0Max.toString(),
        amount1Max: plan.amount1Max.toString(),
      },
      'planned position',
    );

    if (plan.usdgAmount > usdgBalance) {
      throw new InsufficientBalanceError(
        usdg.symbol,
        plan.usdgAmount,
        usdgBalance,
        usdg.decimals,
      );
    }

    return plan;
  }

  /** Sends approvals if needed, then mints. Spends real funds. */
  async execute(plan: DepositPlan): Promise<DepositResult> {
    const {wallet, logger, chainId, usdg, stock} = this.options;
    const deployment = getV4Deployment(chainId);
    const owner = wallet.getAccount().address;

    const approvalContext = {
      publicClient: wallet.getPublicClient(),
      walletClient: wallet.getWalletClient(),
      owner,
      permit2: deployment.permit2,
      spender: deployment.positionManager,
      logger,
    };

    const stockIsCurrency0 = isCurrency0(plan.poolKey, stock.address);
    const stockMax = stockIsCurrency0 ? plan.amount0Max : plan.amount1Max;
    const usdgMax = stockIsCurrency0 ? plan.amount1Max : plan.amount0Max;

    const approvalHashes = [
      ...(await ensureAllowances(approvalContext, usdg.address, usdgMax)),
      ...(await ensureAllowances(approvalContext, stock.address, stockMax)),
    ];

    const result = await mintPosition(
      {
        publicClient: wallet.getPublicClient(),
        walletClient: wallet.getWalletClient(),
        positionManager: deployment.positionManager,
        logger,
      },
      {
        poolKey: plan.poolKey,
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        liquidity: plan.liquidity,
        amount0Max: plan.amount0Max,
        amount1Max: plan.amount1Max,
        recipient: owner,
      },
      this.options.mintDeadlineSeconds,
    );

    return {...result, plan, approvalHashes};
  }

  private buildPlan(
    poolKey: PoolKey,
    poolState: PoolState,
    tickLower: number,
    tickUpper: number,
    stockBalance: bigint,
    usdgBalance: bigint,
  ): DepositPlan {
    const sqrtLower = getSqrtRatioAtTick(tickLower);
    const sqrtUpper = getSqrtRatioAtTick(tickUpper);
    const sqrtCurrent = poolState.sqrtPriceX96;

    const stockIsCurrency0 = isCurrency0(poolKey, this.options.stock.address);

    // The stock balance is the fixed side; derive the liquidity it supports,
    // then the counter-token that liquidity requires.
    const liquidity = stockIsCurrency0
      ? getLiquidityForAmount0(
          sqrtCurrent > sqrtLower ? sqrtCurrent : sqrtLower,
          sqrtUpper,
          stockBalance,
        )
      : getLiquidityForAmount1(
          sqrtLower,
          sqrtCurrent < sqrtUpper ? sqrtCurrent : sqrtUpper,
          stockBalance,
        );

    if (liquidity <= 0n) {
      throw new Error(
        `Stock balance ${stockBalance} is too small to provide liquidity in ` +
          `range [${tickLower}, ${tickUpper}]`,
      );
    }

    const {amount0, amount1} = getAmountsForLiquidity(
      sqrtCurrent,
      sqrtLower,
      sqrtUpper,
      liquidity,
    );

    const amount0Max = withSlippage(amount0, this.options.lpSlippageBps);
    const amount1Max = withSlippage(amount1, this.options.lpSlippageBps);

    return {
      poolKey,
      poolId: poolState.poolId,
      currentTick: poolState.tick,
      tickLower,
      tickUpper,
      liquidity,
      stockAmount: stockIsCurrency0 ? amount0 : amount1,
      usdgAmount: stockIsCurrency0 ? amount1 : amount0,
      amount0Max,
      amount1Max,
      usdgBalance,
    };
  }
}

/** Headroom on the amount the mint may pull, guarding against a tick move. */
function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 + bps)) / 10_000n;
}

async function readBalance(
  client: PublicClient,
  token: Hex,
  owner: Hex,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  });
}
