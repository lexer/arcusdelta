/**
 * Mints a Uniswap v3 position via NonfungiblePositionManager.mint().
 *
 * Unlike v4, minting is a single typed call — there is no action encoding.
 * Tokens are pulled with a plain `transferFrom`, so approval is a direct
 * `approve(NFPM, amount)` rather than the Permit2 double-approval v4 needed.
 *
 * The transaction is simulated before it is broadcast. The confirmed amounts
 * are read from the `IncreaseLiquidity` event the mint emits — the actually
 * executed outcome, not the pre-broadcast simulation.
 */

import {
  decodeEventLog,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import type {Logger} from '../logging/logger.js';
import type {PoolIdentity} from './poolAddress.js';

export const POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {name: 'token0', type: 'address'},
          {name: 'token1', type: 'address'},
          {name: 'fee', type: 'uint24'},
          {name: 'tickLower', type: 'int24'},
          {name: 'tickUpper', type: 'int24'},
          {name: 'amount0Desired', type: 'uint256'},
          {name: 'amount1Desired', type: 'uint256'},
          {name: 'amount0Min', type: 'uint256'},
          {name: 'amount1Min', type: 'uint256'},
          {name: 'recipient', type: 'address'},
          {name: 'deadline', type: 'uint256'},
        ],
      },
    ],
    outputs: [
      {name: 'tokenId', type: 'uint256'},
      {name: 'liquidity', type: 'uint128'},
      {name: 'amount0', type: 'uint256'},
      {name: 'amount1', type: 'uint256'},
    ],
  },
  {
    type: 'event',
    name: 'IncreaseLiquidity',
    inputs: [
      {name: 'tokenId', type: 'uint256', indexed: true},
      {name: 'liquidity', type: 'uint128', indexed: false},
      {name: 'amount0', type: 'uint256', indexed: false},
      {name: 'amount1', type: 'uint256', indexed: false},
    ],
  },
] as const;

export interface MintParams {
  readonly pool: PoolIdentity;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly amount0Desired: bigint;
  readonly amount1Desired: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly recipient: Hex;
}

export interface MintResult {
  readonly hash: Hex;
  readonly tokenId: bigint | undefined;
  readonly liquidity: bigint | undefined;
  readonly amount0: bigint | undefined;
  readonly amount1: bigint | undefined;
  readonly gasUsed: bigint;
}

export interface MintContext {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly positionManager: Hex;
  readonly logger: Logger;
}

/**
 * Simulates the mint and, only if that succeeds, broadcasts it.
 *
 * A revert therefore costs nothing and never reaches the chain.
 */
export async function mintPosition(
  context: MintContext,
  params: MintParams,
  deadlineSeconds: number,
): Promise<MintResult> {
  const {publicClient, walletClient, positionManager, logger} = context;
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const mintArgs = {
    token0: params.pool.token0,
    token1: params.pool.token1,
    fee: params.pool.fee,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
    amount0Desired: params.amount0Desired,
    amount1Desired: params.amount1Desired,
    amount0Min: params.amount0Min,
    amount1Min: params.amount1Min,
    recipient: params.recipient,
    deadline,
  };

  logger.info(
    {
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      amount0Desired: params.amount0Desired.toString(),
      amount1Desired: params.amount1Desired.toString(),
      amount0Min: params.amount0Min.toString(),
      amount1Min: params.amount1Min.toString(),
      deadline: deadline.toString(),
    },
    'simulating mint',
  );

  const {request} = await publicClient.simulateContract({
    account,
    address: positionManager,
    abi: POSITION_MANAGER_ABI,
    functionName: 'mint',
    args: [mintArgs],
  });
  logger.info('mint simulation succeeded');

  const hash = await walletClient.writeContract(request);
  logger.info({hash}, 'mint submitted');

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    throw new Error(`Mint transaction ${hash} reverted on chain`);
  }

  const minted = extractIncreaseLiquidity(receipt, positionManager);
  logger.info(
    {
      hash,
      tokenId: minted?.tokenId.toString(),
      liquidity: minted?.liquidity.toString(),
      amount0: minted?.amount0.toString(),
      amount1: minted?.amount1.toString(),
      gasUsed: receipt.gasUsed.toString(),
    },
    'mint confirmed',
  );

  return {
    hash,
    tokenId: minted?.tokenId,
    liquidity: minted?.liquidity,
    amount0: minted?.amount0,
    amount1: minted?.amount1,
    gasUsed: receipt.gasUsed,
  };
}

/** Reads the confirmed tokenId and amounts from the mint's IncreaseLiquidity log. */
export function extractIncreaseLiquidity(
  receipt: TransactionReceipt,
  positionManager: Hex,
):
  | {tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint}
  | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: POSITION_MANAGER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName === 'IncreaseLiquidity') {
        return {
          tokenId: event.args.tokenId,
          liquidity: event.args.liquidity,
          amount0: event.args.amount0,
          amount1: event.args.amount1,
        };
      }
    } catch {
      // Not an IncreaseLiquidity log; keep looking.
    }
  }
  return undefined;
}
