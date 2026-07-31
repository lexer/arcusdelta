/**
 * Discovers and reads Uniswap v4 positions owned by the wallet.
 *
 * PositionManager is not ERC721Enumerable, so ownership is discovered from
 * `Transfer` logs rather than an on-chain index. Discovery deliberately filters
 * by pool key: the wallet may hold positions in other pools, and those must
 * stay invisible to anything that closes positions.
 */

import {parseAbiItem, type Hex, type PublicClient} from 'viem';
import type {Logger} from '../logging/logger.js';
import {getV4Deployment} from './deployments.js';
import {toPoolId, type PoolKey} from './poolKey.js';

export const POSITION_READ_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [{type: 'address'}],
  },
  {
    type: 'function',
    name: 'getPositionLiquidity',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [{name: 'liquidity', type: 'uint128'}],
  },
  {
    type: 'function',
    name: 'getPoolAndPositionInfo',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          {name: 'currency0', type: 'address'},
          {name: 'currency1', type: 'address'},
          {name: 'fee', type: 'uint24'},
          {name: 'tickSpacing', type: 'int24'},
          {name: 'hooks', type: 'address'},
        ],
      },
      {name: 'info', type: 'uint256'},
    ],
  },
] as const;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed id)',
);

/** Blocks per eth_getLogs request. Providers cap the range they will serve. */
const LOG_CHUNK_BLOCKS = 50_000n;

export interface OwnedPosition {
  readonly tokenId: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
}

/**
 * Decodes the tick bounds from a packed v4 `PositionInfo`.
 *
 * Layout, from PositionInfoLibrary: bits 0-7 hasSubscriber, 8-31 tickLower,
 * 32-55 tickUpper, remainder the truncated pool id. Both ticks are signed.
 */
export function decodePositionTicks(info: bigint): {
  tickLower: number;
  tickUpper: number;
} {
  return {
    tickLower: Number(BigInt.asIntN(24, (info >> 8n) & 0xffffffn)),
    tickUpper: Number(BigInt.asIntN(24, (info >> 32n) & 0xffffffn)),
  };
}

export interface PositionReader {
  /** Positions the owner still holds in `key`, with non-zero liquidity. */
  discover(key: PoolKey, owner: Hex): Promise<OwnedPosition[]>;
  /** Reads one position, or undefined if it is gone, empty, or another pool's. */
  read(
    tokenId: bigint,
    key: PoolKey,
    owner: Hex,
  ): Promise<OwnedPosition | undefined>;
}

export function createPositionReader(
  client: PublicClient,
  chainId: number,
  lookbackBlocks: number,
  logger: Logger,
): PositionReader {
  const positionManager = getV4Deployment(chainId).positionManager;

  async function read(
    tokenId: bigint,
    key: PoolKey,
    owner: Hex,
  ): Promise<OwnedPosition | undefined> {
    const expectedPoolId = toPoolId(key);
    try {
      const [currentOwner, liquidity, poolAndInfo] = await Promise.all([
        client.readContract({
          address: positionManager,
          abi: POSITION_READ_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
        }),
        client.readContract({
          address: positionManager,
          abi: POSITION_READ_ABI,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
        }),
        client.readContract({
          address: positionManager,
          abi: POSITION_READ_ABI,
          functionName: 'getPoolAndPositionInfo',
          args: [tokenId],
        }),
      ]);

      if (currentOwner.toLowerCase() !== owner.toLowerCase()) return undefined;
      if (liquidity === 0n) return undefined;

      const [poolKey, info] = poolAndInfo;
      // Compare by pool id so every key field must match, not just the pair.
      if (toPoolId(poolKey as PoolKey) !== expectedPoolId) return undefined;

      const {tickLower, tickUpper} = decodePositionTicks(info);
      return {tokenId, tickLower, tickUpper, liquidity};
    } catch (error) {
      // A burned token reverts on ownerOf; that is a normal outcome here.
      logger.debug(
        {tokenId: tokenId.toString(), error: String(error)},
        'position read failed, skipping',
      );
      return undefined;
    }
  }

  return {
    read,

    async discover(key: PoolKey, owner: Hex): Promise<OwnedPosition[]> {
      const latest = await client.getBlockNumber();
      const earliest =
        latest > BigInt(lookbackBlocks) ? latest - BigInt(lookbackBlocks) : 0n;

      logger.info(
        {
          owner,
          poolId: toPoolId(key),
          fromBlock: earliest.toString(),
          toBlock: latest.toString(),
        },
        'discovering positions',
      );

      const candidates = new Set<bigint>();
      for (let end = latest; end > earliest; end -= LOG_CHUNK_BLOCKS) {
        const start =
          end > earliest + LOG_CHUNK_BLOCKS ? end - LOG_CHUNK_BLOCKS : earliest;
        try {
          const logs = await client.getLogs({
            address: positionManager,
            event: TRANSFER_EVENT,
            args: {to: owner},
            fromBlock: start,
            toBlock: end,
          });
          for (const entry of logs) {
            if (entry.args.id !== undefined) candidates.add(entry.args.id);
          }
        } catch (error) {
          logger.warn(
            {
              fromBlock: start.toString(),
              toBlock: end.toString(),
              error: String(error),
            },
            'log range rejected, skipping chunk',
          );
        }
      }

      const positions: OwnedPosition[] = [];
      for (const tokenId of candidates) {
        const position = await read(tokenId, key, owner);
        if (position) positions.push(position);
      }
      positions.sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));

      logger.info(
        {
          candidates: candidates.size,
          matched: positions.length,
          tokenIds: positions.map(p => p.tokenId.toString()),
        },
        'discovered positions',
      );
      return positions;
    },
  };
}
