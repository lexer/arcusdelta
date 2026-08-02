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
import {ensureAllowance, ERC20_ABI} from './erc20.js';
import {getV3Deployment} from './deployments.js';
import {
  getAmountsForLiquidity,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
} from './liquidityMath.js';
import {
  isToken0,
  resolvePoolIdentity,
  type PoolIdentity,
} from './poolAddress.js';
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
  readonly pool: PoolIdentity;
  readonly currentTick: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly stockAmount: bigint;
  readonly usdgAmount: bigint;
  /** Ceiling the mint may pull, computed amount plus `lpSlippageBps`. */
  readonly amount0Desired: bigint;
  readonly amount1Desired: bigint;
  /** Floor the mint must return, computed amount minus `lpSlippageBps`. */
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
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
    const {wallet, poolReader, logger, usdg, stock, chainId} = this.options;
    const owner = wallet.getAccount().address;
    const client = wallet.getPublicClient();

    const pool = await resolvePoolIdentity(
      client,
      chainId,
      usdg.address,
      stock.address,
      this.options.poolFee,
    );

    const [poolState, stockBalance, usdgBalance] = await Promise.all([
      poolReader.readState(pool),
      readBalance(client, stock.address, owner),
      readBalance(client, usdg.address, owner),
    ]);

    logger.info(
      {
        poolAddress: pool.address,
        tick: poolState.tick,
        tickSpacing: pool.tickSpacing,
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
      pool.tickSpacing,
    );

    const plan = this.buildPlan(
      pool,
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
        amount0Desired: plan.amount0Desired.toString(),
        amount1Desired: plan.amount1Desired.toString(),
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
    const positionManager = getV3Deployment(chainId).positionManager;
    const owner = wallet.getAccount().address;

    const approvalContext = {
      publicClient: wallet.getPublicClient(),
      walletClient: wallet.getWalletClient(),
      owner,
      spender: positionManager,
      logger,
    };

    const stockIsToken0 = isToken0(plan.pool, stock.address);
    const stockDesired = stockIsToken0
      ? plan.amount0Desired
      : plan.amount1Desired;
    const usdgDesired = stockIsToken0
      ? plan.amount1Desired
      : plan.amount0Desired;

    const approvalHashes = (
      await Promise.all([
        ensureAllowance(approvalContext, usdg.address, usdgDesired),
        ensureAllowance(approvalContext, stock.address, stockDesired),
      ])
    ).filter((hash): hash is Hex => hash !== undefined);

    const result = await mintPosition(
      {
        publicClient: wallet.getPublicClient(),
        walletClient: wallet.getWalletClient(),
        positionManager,
        logger,
      },
      {
        pool: plan.pool,
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        amount0Desired: plan.amount0Desired,
        amount1Desired: plan.amount1Desired,
        amount0Min: plan.amount0Min,
        amount1Min: plan.amount1Min,
        recipient: owner,
      },
      this.options.mintDeadlineSeconds,
    );

    return {...result, plan, approvalHashes};
  }

  private buildPlan(
    pool: PoolIdentity,
    poolState: PoolState,
    tickLower: number,
    tickUpper: number,
    stockBalance: bigint,
    usdgBalance: bigint,
  ): DepositPlan {
    const sqrtLower = getSqrtRatioAtTick(tickLower);
    const sqrtUpper = getSqrtRatioAtTick(tickUpper);
    const sqrtCurrent = poolState.sqrtPriceX96;

    const stockIsToken0 = isToken0(pool, this.options.stock.address);

    // The stock balance is the fixed side; derive the liquidity it supports,
    // then the counter-token that liquidity requires.
    const liquidity = stockIsToken0
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

    const bps = this.options.lpSlippageBps;
    const amount0Desired = withHeadroom(amount0, bps);
    const amount1Desired = withHeadroom(amount1, bps);
    const amount0Min = withFloor(amount0, bps);
    const amount1Min = withFloor(amount1, bps);

    return {
      pool,
      currentTick: poolState.tick,
      tickLower,
      tickUpper,
      liquidity,
      stockAmount: stockIsToken0 ? amount0 : amount1,
      usdgAmount: stockIsToken0 ? amount1 : amount0,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      usdgBalance,
    };
  }
}

/** Ceiling the mint may pull, guarding against a tick move before it lands. */
function withHeadroom(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 + bps)) / 10_000n;
}

/** Floor the mint must return, guarding against a sandwiched fill. */
function withFloor(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
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
