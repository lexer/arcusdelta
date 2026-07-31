/**
 * Reads uncollected fees for a position from the v4 StateView lens.
 *
 * Shared by the PnL report and the exit flow so both quote the same number.
 * The arithmetic itself lives in pnl/pnlCalculator, which is pure.
 */

import type {Hex, PublicClient} from 'viem';
import {accruedFees} from '../pnl/pnlCalculator.js';
import {getV4Deployment} from './deployments.js';
import {toPoolId, type PoolKey} from './poolKey.js';
import type {OwnedPosition} from './positionReader.js';

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

export interface FeeReader {
  read(
    key: PoolKey,
    position: OwnedPosition,
  ): Promise<{fees0: bigint; fees1: bigint}>;
}

export function createFeeReader(
  client: PublicClient,
  chainId: number,
): FeeReader {
  const deployment = getV4Deployment(chainId);

  return {
    async read(key: PoolKey, position: OwnedPosition) {
      const poolId = toPoolId(key);
      // PoolManager sees PositionManager as the owner; the NFT id is the salt.
      const salt = `0x${position.tokenId
        .toString(16)
        .padStart(64, '0')}` as Hex;

      const [info, growth] = await Promise.all([
        client.readContract({
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
        client.readContract({
          address: deployment.stateView,
          abi: FEE_STATE_ABI,
          functionName: 'getFeeGrowthInside',
          args: [poolId, position.tickLower, position.tickUpper],
        }),
      ]);

      const [liquidity, last0, last1] = info;
      const [inside0, inside1] = growth;
      return accruedFees(BigInt(liquidity), inside0, inside1, last0, last1);
    },
  };
}
