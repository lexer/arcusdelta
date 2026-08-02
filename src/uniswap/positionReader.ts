/**
 * Discovers and reads Uniswap v3 positions owned by the wallet.
 *
 * `NonfungiblePositionManager` implements `IERC721Enumerable`, so ownership
 * comes from a direct `balanceOf` + `tokenOfOwnerByIndex` read — no block-range
 * log scan, no lookback window to get wrong. Discovery still filters by pool
 * (token0, token1, fee), since the wallet may hold positions in other pools
 * and those must stay invisible to anything that closes positions.
 */

import type {Hex, PublicClient} from 'viem';
import {getAddress} from 'viem';
import {getV3Deployment} from './deployments.js';
import type {PoolIdentity} from './poolAddress.js';

export const POSITION_READ_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'owner', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'index', type: 'uint256'},
    ],
    outputs: [{name: 'tokenId', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [
      {name: 'nonce', type: 'uint96'},
      {name: 'operator', type: 'address'},
      {name: 'token0', type: 'address'},
      {name: 'token1', type: 'address'},
      {name: 'fee', type: 'uint24'},
      {name: 'tickLower', type: 'int24'},
      {name: 'tickUpper', type: 'int24'},
      {name: 'liquidity', type: 'uint128'},
      {name: 'feeGrowthInside0LastX128', type: 'uint256'},
      {name: 'feeGrowthInside1LastX128', type: 'uint256'},
      {name: 'tokensOwed0', type: 'uint128'},
      {name: 'tokensOwed1', type: 'uint128'},
    ],
  },
] as const;

export interface OwnedPosition {
  readonly tokenId: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly feeGrowthInside0LastX128: bigint;
  readonly feeGrowthInside1LastX128: bigint;
}

export interface PositionReader {
  /** Positions the owner holds in `pool`, with non-zero liquidity. */
  discover(pool: PoolIdentity, owner: Hex): Promise<OwnedPosition[]>;
  /** Reads one position, or undefined if it is gone, empty, or another pool's. */
  read(
    tokenId: bigint,
    pool: PoolIdentity,
    owner?: Hex,
  ): Promise<OwnedPosition | undefined>;
}

export function createPositionReader(
  client: PublicClient,
  chainId: number,
): PositionReader {
  const positionManager = getV3Deployment(chainId).positionManager;

  async function read(
    tokenId: bigint,
    pool: PoolIdentity,
    owner?: Hex,
  ): Promise<OwnedPosition | undefined> {
    try {
      const info = await client.readContract({
        address: positionManager,
        abi: POSITION_READ_ABI,
        functionName: 'positions',
        args: [tokenId],
      });
      const [
        ,
        ,
        token0,
        token1,
        fee,
        tickLower,
        tickUpper,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      ] = info;

      if (liquidity === 0n) return undefined;
      if (getAddress(token0) !== getAddress(pool.token0)) return undefined;
      if (getAddress(token1) !== getAddress(pool.token1)) return undefined;
      if (fee !== pool.fee) return undefined;

      if (owner) {
        // positions() doesn't return the owner; a caller who cares must check
        // separately (a burned tokenId reverts positions(), so this only
        // matters for "does this wallet still hold it").
        const currentOwner = await client.readContract({
          address: positionManager,
          abi: [
            {
              type: 'function',
              name: 'ownerOf',
              stateMutability: 'view',
              inputs: [{name: 'tokenId', type: 'uint256'}],
              outputs: [{type: 'address'}],
            },
          ] as const,
          functionName: 'ownerOf',
          args: [tokenId],
        });
        if (getAddress(currentOwner) !== getAddress(owner)) return undefined;
      }

      return {
        tokenId,
        tickLower,
        tickUpper,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      };
    } catch {
      // Burned or never minted; a normal outcome here.
      return undefined;
    }
  }

  return {
    read,

    async discover(pool: PoolIdentity, owner: Hex): Promise<OwnedPosition[]> {
      const balance = await client.readContract({
        address: positionManager,
        abi: POSITION_READ_ABI,
        functionName: 'balanceOf',
        args: [owner],
      });

      const tokenIds = await Promise.all(
        Array.from({length: Number(balance)}, (_, index) =>
          client.readContract({
            address: positionManager,
            abi: POSITION_READ_ABI,
            functionName: 'tokenOfOwnerByIndex',
            args: [owner, BigInt(index)],
          }),
        ),
      );

      const positions = await Promise.all(
        tokenIds.map(tokenId => read(tokenId, pool)),
      );
      return positions.filter((p): p is OwnedPosition => p !== undefined);
    },
  };
}
