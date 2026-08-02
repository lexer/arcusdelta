/**
 * Reads live state directly from a v3 pool contract.
 *
 * Unlike v4's singleton PoolManager plus a StateView lens, each v3 pool is
 * its own contract, so state comes straight from the pool `resolvePoolIdentity`
 * already resolved.
 */

import type {Hex, PublicClient} from 'viem';
import type {PoolIdentity} from './poolAddress.js';

export const POOL_STATE_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {name: 'sqrtPriceX96', type: 'uint160'},
      {name: 'tick', type: 'int24'},
      {name: 'observationIndex', type: 'uint16'},
      {name: 'observationCardinality', type: 'uint16'},
      {name: 'observationCardinalityNext', type: 'uint16'},
      {name: 'feeProtocol', type: 'uint8'},
      {name: 'unlocked', type: 'bool'},
    ],
  },
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint128'}],
  },
] as const;

export class PoolNotInitializedError extends Error {
  constructor(readonly poolAddress: Hex) {
    super(
      `Pool ${poolAddress} exists but was never initialized with a starting price.`,
    );
    this.name = 'PoolNotInitializedError';
  }
}

export interface PoolState {
  readonly poolAddress: Hex;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
}

export interface PoolReader {
  readState(identity: PoolIdentity): Promise<PoolState>;
}

export function createPoolReader(client: PublicClient): PoolReader {
  return {
    async readState(identity: PoolIdentity): Promise<PoolState> {
      const [slot0, liquidity] = await Promise.all([
        client.readContract({
          address: identity.address,
          abi: POOL_STATE_ABI,
          functionName: 'slot0',
        }),
        client.readContract({
          address: identity.address,
          abi: POOL_STATE_ABI,
          functionName: 'liquidity',
        }),
      ]);

      const [sqrtPriceX96, tick] = slot0;
      if (sqrtPriceX96 === 0n) {
        throw new PoolNotInitializedError(identity.address);
      }

      return {poolAddress: identity.address, sqrtPriceX96, tick, liquidity};
    },
  };
}
