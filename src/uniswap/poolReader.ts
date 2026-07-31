/**
 * Reads live pool state through the v4 StateView lens contract.
 *
 * v4 keeps pool state in the PoolManager singleton's transient-friendly
 * storage; StateView is the read-only accessor for it.
 */

import type {Hex, PublicClient} from 'viem';
import {getV4Deployment} from './deployments.js';
import {toPoolId, type PoolKey} from './poolKey.js';

export const STATE_VIEW_ABI = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{name: 'poolId', type: 'bytes32'}],
    outputs: [
      {name: 'sqrtPriceX96', type: 'uint160'},
      {name: 'tick', type: 'int24'},
      {name: 'protocolFee', type: 'uint24'},
      {name: 'lpFee', type: 'uint24'},
    ],
  },
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{name: 'poolId', type: 'bytes32'}],
    outputs: [{name: 'liquidity', type: 'uint128'}],
  },
] as const;

export class PoolNotInitializedError extends Error {
  readonly poolId: Hex;

  constructor(poolId: Hex, key: PoolKey) {
    super(
      `Pool ${poolId} is not initialized (currency0=${key.currency0}, ` +
        `currency1=${key.currency1}, fee=${key.fee}, tickSpacing=${key.tickSpacing}). ` +
        'Check POOL_FEE and POOL_TICK_SPACING match a live pool.',
    );
    this.name = 'PoolNotInitializedError';
    this.poolId = poolId;
  }
}

export interface PoolState {
  readonly poolId: Hex;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly lpFee: number;
  readonly liquidity: bigint;
}

export interface PoolReader {
  readState(key: PoolKey): Promise<PoolState>;
}

export function createPoolReader(
  client: PublicClient,
  chainId: number,
): PoolReader {
  const stateView = getV4Deployment(chainId).stateView;

  return {
    async readState(key: PoolKey): Promise<PoolState> {
      const poolId = toPoolId(key);

      const [slot0, liquidity] = await Promise.all([
        client.readContract({
          address: stateView,
          abi: STATE_VIEW_ABI,
          functionName: 'getSlot0',
          args: [poolId],
        }),
        client.readContract({
          address: stateView,
          abi: STATE_VIEW_ABI,
          functionName: 'getLiquidity',
          args: [poolId],
        }),
      ]);

      const [sqrtPriceX96, tick, , lpFee] = slot0;
      if (sqrtPriceX96 === 0n) {
        throw new PoolNotInitializedError(poolId, key);
      }

      return {poolId, sqrtPriceX96, tick, lpFee, liquidity};
    },
  };
}
