/**
 * Encodes and sends a Uniswap v4 mint through PositionManager.
 *
 * v4 routes every liquidity operation through `modifyLiquidities`, which takes
 * an abi-encoded (actions, params) pair executed inside a PoolManager unlock.
 * Minting is two actions: MINT_POSITION creates the position and records what
 * it owes, SETTLE_PAIR pays both currencies from the caller.
 *
 * Every transaction here is simulated before it is broadcast.
 */

import {
  decodeEventLog,
  encodeAbiParameters,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import type {Logger} from '../logging/logger.js';
import {POOL_KEY_ABI, type PoolKey} from './poolKey.js';

/** v4-periphery Actions. */
export const ACTION_MINT_POSITION = 0x02;
export const ACTION_SETTLE_PAIR = 0x0d;

export const POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'modifyLiquidities',
    stateMutability: 'payable',
    inputs: [
      {name: 'unlockData', type: 'bytes'},
      {name: 'deadline', type: 'uint256'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nextTokenId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      {name: 'from', type: 'address', indexed: true},
      {name: 'to', type: 'address', indexed: true},
      {name: 'id', type: 'uint256', indexed: true},
    ],
  },
] as const;

const MINT_PARAMS_ABI = [
  {name: 'poolKey', type: 'tuple', components: POOL_KEY_ABI},
  {name: 'tickLower', type: 'int24'},
  {name: 'tickUpper', type: 'int24'},
  {name: 'liquidity', type: 'uint256'},
  {name: 'amount0Max', type: 'uint128'},
  {name: 'amount1Max', type: 'uint128'},
  {name: 'recipient', type: 'address'},
  {name: 'hookData', type: 'bytes'},
] as const;

const SETTLE_PAIR_PARAMS_ABI = [
  {name: 'currency0', type: 'address'},
  {name: 'currency1', type: 'address'},
] as const;

const UNLOCK_DATA_ABI = [
  {name: 'actions', type: 'bytes'},
  {name: 'params', type: 'bytes[]'},
] as const;

export interface MintParams {
  readonly poolKey: PoolKey;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly amount0Max: bigint;
  readonly amount1Max: bigint;
  readonly recipient: Hex;
}

/** Builds the `unlockData` argument for a mint. Pure; unit tested directly. */
export function encodeMintUnlockData(params: MintParams): Hex {
  const actions =
    `0x${ACTION_MINT_POSITION.toString(16).padStart(2, '0')}${ACTION_SETTLE_PAIR.toString(16).padStart(2, '0')}` as Hex;

  const mintParams = encodeAbiParameters(MINT_PARAMS_ABI, [
    {
      currency0: params.poolKey.currency0,
      currency1: params.poolKey.currency1,
      fee: params.poolKey.fee,
      tickSpacing: params.poolKey.tickSpacing,
      hooks: params.poolKey.hooks,
    },
    params.tickLower,
    params.tickUpper,
    params.liquidity,
    params.amount0Max,
    params.amount1Max,
    params.recipient,
    '0x',
  ]);

  const settleParams = encodeAbiParameters(SETTLE_PAIR_PARAMS_ABI, [
    params.poolKey.currency0,
    params.poolKey.currency1,
  ]);

  return encodeAbiParameters(UNLOCK_DATA_ABI, [
    actions,
    [mintParams, settleParams],
  ]);
}

export interface MintResult {
  readonly hash: Hex;
  readonly tokenId: bigint | undefined;
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

  const unlockData = encodeMintUnlockData(params);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  logger.info(
    {
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      liquidity: params.liquidity.toString(),
      amount0Max: params.amount0Max.toString(),
      amount1Max: params.amount1Max.toString(),
      deadline: deadline.toString(),
    },
    'simulating mint',
  );

  const {request} = await publicClient.simulateContract({
    account,
    address: positionManager,
    abi: POSITION_MANAGER_ABI,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
  });
  logger.info('mint simulation succeeded');

  const hash = await walletClient.writeContract(request);
  logger.info({hash}, 'mint submitted');

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    throw new Error(`Mint transaction ${hash} reverted on chain`);
  }

  const tokenId = extractMintedTokenId(
    receipt,
    positionManager,
    params.recipient,
  );
  logger.info(
    {hash, tokenId: tokenId?.toString(), gasUsed: receipt.gasUsed.toString()},
    'mint confirmed',
  );

  return {hash, tokenId, gasUsed: receipt.gasUsed};
}

/** Finds the position NFT id from the ERC-721 Transfer log the mint emits. */
export function extractMintedTokenId(
  receipt: TransactionReceipt,
  positionManager: Hex,
  recipient: Hex,
): bigint | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: POSITION_MANAGER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (
        event.eventName === 'Transfer' &&
        event.args.to.toLowerCase() === recipient.toLowerCase()
      ) {
        return event.args.id;
      }
    } catch {
      // Not a Transfer log; keep looking.
    }
  }
  return undefined;
}
