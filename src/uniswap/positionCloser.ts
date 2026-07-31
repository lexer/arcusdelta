/**
 * Closes a Uniswap v4 position: burn the liquidity and take both currencies.
 *
 * `PositionManager._burn` removes all liquidity *and* returns accrued fees in
 * the same call, so principal and fees arrive together — there is no separate
 * collect step. TAKE_PAIR then sweeps both currencies to the recipient.
 *
 * The transaction is simulated before it is broadcast.
 */

import {
  encodeAbiParameters,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type {Logger} from '../logging/logger.js';
import {getAmountsForLiquidity} from './liquidityMath.js';
import type {PoolKey} from './poolKey.js';
import {POSITION_MANAGER_ABI} from './positionManager.js';
import type {OwnedPosition} from './positionReader.js';
import {getSqrtRatioAtTick} from './tickMath.js';

/** v4-periphery Actions. */
export const ACTION_BURN_POSITION = 0x03;
export const ACTION_TAKE_PAIR = 0x11;

const BURN_PARAMS_ABI = [
  {name: 'tokenId', type: 'uint256'},
  {name: 'amount0Min', type: 'uint128'},
  {name: 'amount1Min', type: 'uint128'},
  {name: 'hookData', type: 'bytes'},
] as const;

const TAKE_PAIR_PARAMS_ABI = [
  {name: 'currency0', type: 'address'},
  {name: 'currency1', type: 'address'},
  {name: 'recipient', type: 'address'},
] as const;

const UNLOCK_DATA_ABI = [
  {name: 'actions', type: 'bytes'},
  {name: 'params', type: 'bytes[]'},
] as const;

export interface CloseParams {
  readonly tokenId: bigint;
  readonly poolKey: PoolKey;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly recipient: Hex;
}

/** Builds the `unlockData` for a close. Pure; unit tested directly. */
export function encodeCloseUnlockData(params: CloseParams): Hex {
  const actions =
    `0x${ACTION_BURN_POSITION.toString(16).padStart(2, '0')}${ACTION_TAKE_PAIR.toString(16).padStart(2, '0')}` as Hex;

  const burnParams = encodeAbiParameters(BURN_PARAMS_ABI, [
    params.tokenId,
    params.amount0Min,
    params.amount1Min,
    '0x',
  ]);

  const takeParams = encodeAbiParameters(TAKE_PAIR_PARAMS_ABI, [
    params.poolKey.currency0,
    params.poolKey.currency1,
    params.recipient,
  ]);

  return encodeAbiParameters(UNLOCK_DATA_ABI, [
    actions,
    [burnParams, takeParams],
  ]);
}

/**
 * Minimum amounts to accept from the burn, derived from what the position is
 * worth at the current price less `slippageBps`. Bounds a sandwiched close:
 * the burn reverts rather than settling badly.
 */
export function calculateMinimums(
  position: OwnedPosition,
  sqrtPriceX96: bigint,
  slippageBps: number,
): {amount0Min: bigint; amount1Min: bigint} {
  const {amount0, amount1} = getAmountsForLiquidity(
    sqrtPriceX96,
    getSqrtRatioAtTick(position.tickLower),
    getSqrtRatioAtTick(position.tickUpper),
    position.liquidity,
  );
  const factor = BigInt(10_000 - slippageBps);
  return {
    amount0Min: (amount0 * factor) / 10_000n,
    amount1Min: (amount1 * factor) / 10_000n,
  };
}

export interface CloseResult {
  readonly hash: Hex;
  readonly gasUsed: bigint;
}

export interface CloseContext {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly positionManager: Hex;
  readonly logger: Logger;
}

export async function closePosition(
  context: CloseContext,
  params: CloseParams,
  deadlineSeconds: number,
): Promise<CloseResult> {
  const {publicClient, walletClient, positionManager, logger} = context;
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const unlockData = encodeCloseUnlockData(params);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  logger.info(
    {
      tokenId: params.tokenId.toString(),
      amount0Min: params.amount0Min.toString(),
      amount1Min: params.amount1Min.toString(),
      deadline: deadline.toString(),
    },
    'simulating close',
  );

  const {request} = await publicClient.simulateContract({
    account,
    address: positionManager,
    abi: POSITION_MANAGER_ABI,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
  });
  logger.info('close simulation succeeded');

  const hash = await walletClient.writeContract(request);
  logger.info({hash}, 'close submitted');

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    throw new Error(`Close transaction ${hash} reverted on chain`);
  }

  logger.info(
    {
      hash,
      tokenId: params.tokenId.toString(),
      gasUsed: receipt.gasUsed.toString(),
    },
    'close confirmed',
  );
  return {hash, gasUsed: receipt.gasUsed};
}
