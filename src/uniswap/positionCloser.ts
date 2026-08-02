/**
 * Closes a Uniswap v3 position: remove all liquidity, then collect everything
 * owed — principal plus accrued fees — in one `multicall` transaction.
 *
 * `decreaseLiquidity` accounts the principal into the position's `tokensOwed`;
 * `collect` sweeps whatever is owed (principal and fees together) to the
 * recipient. `amount0Max`/`amount1Max` on the collect are left at the maximum,
 * since `decreaseLiquidity`'s own `amount0Min`/`amount1Min` is what bounds a
 * sandwiched close — collect only ever takes what decreaseLiquidity accounted.
 *
 * The transaction is simulated before it is broadcast.
 */

import {
  encodeFunctionData,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type {Logger} from '../logging/logger.js';
import {getAmountsForLiquidity} from './liquidityMath.js';
import type {OwnedPosition} from './positionReader.js';
import {getSqrtRatioAtTick} from './tickMath.js';

export const CLOSE_ABI = [
  {
    type: 'function',
    name: 'decreaseLiquidity',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {name: 'tokenId', type: 'uint256'},
          {name: 'liquidity', type: 'uint128'},
          {name: 'amount0Min', type: 'uint256'},
          {name: 'amount1Min', type: 'uint256'},
          {name: 'deadline', type: 'uint256'},
        ],
      },
    ],
    outputs: [
      {name: 'amount0', type: 'uint256'},
      {name: 'amount1', type: 'uint256'},
    ],
  },
  {
    type: 'function',
    name: 'collect',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {name: 'tokenId', type: 'uint256'},
          {name: 'recipient', type: 'address'},
          {name: 'amount0Max', type: 'uint128'},
          {name: 'amount1Max', type: 'uint128'},
        ],
      },
    ],
    outputs: [
      {name: 'amount0', type: 'uint256'},
      {name: 'amount1', type: 'uint256'},
    ],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{name: 'data', type: 'bytes[]'}],
    outputs: [{name: 'results', type: 'bytes[]'}],
  },
] as const;

const MAX_UINT128 = 2n ** 128n - 1n;

export interface CloseParams {
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly recipient: Hex;
}

/** Builds the two calls bundled into the close multicall. Pure; unit tested directly. */
export function encodeCloseCalls(params: CloseParams, deadline: bigint): Hex[] {
  return [
    encodeFunctionData({
      abi: CLOSE_ABI,
      functionName: 'decreaseLiquidity',
      args: [
        {
          tokenId: params.tokenId,
          liquidity: params.liquidity,
          amount0Min: params.amount0Min,
          amount1Min: params.amount1Min,
          deadline,
        },
      ],
    }),
    encodeFunctionData({
      abi: CLOSE_ABI,
      functionName: 'collect',
      args: [
        {
          tokenId: params.tokenId,
          recipient: params.recipient,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
    }),
  ];
}

/**
 * Minimum amounts to accept from the decrease, derived from what the position
 * is worth at the current price less `slippageBps`. Bounds a sandwiched
 * close: the multicall reverts rather than settling badly.
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

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const calls = encodeCloseCalls(params, deadline);

  logger.info(
    {
      tokenId: params.tokenId.toString(),
      liquidity: params.liquidity.toString(),
      amount0Min: params.amount0Min.toString(),
      amount1Min: params.amount1Min.toString(),
      deadline: deadline.toString(),
    },
    'simulating close',
  );

  const {request} = await publicClient.simulateContract({
    account,
    address: positionManager,
    abi: CLOSE_ABI,
    functionName: 'multicall',
    args: [calls],
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
