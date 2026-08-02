/**
 * Reads uncollected fees for a v3 position from live pool state.
 *
 * Shared by the PnL report and the exit flow so both quote the same number.
 * v3 has no single-call lens for this (unlike v4's StateView), so the
 * inside/outside split is computed here from three reads — the pool's global
 * fee growth accumulators and the outside growth recorded at each tick
 * boundary — using the formula in `pnl/pnlCalculator.ts`.
 */

import type {PublicClient} from 'viem';
import {accruedFees, computeFeeGrowthInside} from '../pnl/pnlCalculator.js';
import type {PoolIdentity} from './poolAddress.js';
import type {OwnedPosition} from './positionReader.js';

export const POOL_FEE_STATE_ABI = [
  {
    type: 'function',
    name: 'feeGrowthGlobal0X128',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'feeGrowthGlobal1X128',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint256'}],
  },
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
    name: 'ticks',
    stateMutability: 'view',
    inputs: [{name: 'tick', type: 'int24'}],
    outputs: [
      {name: 'liquidityGross', type: 'uint128'},
      {name: 'liquidityNet', type: 'int128'},
      {name: 'feeGrowthOutside0X128', type: 'uint256'},
      {name: 'feeGrowthOutside1X128', type: 'uint256'},
      {name: 'tickCumulativeOutside', type: 'int56'},
      {name: 'secondsPerLiquidityOutsideX128', type: 'uint160'},
      {name: 'secondsOutside', type: 'uint32'},
      {name: 'initialized', type: 'bool'},
    ],
  },
] as const;

export interface FeeReader {
  read(
    pool: PoolIdentity,
    position: OwnedPosition,
  ): Promise<{fees0: bigint; fees1: bigint}>;
}

export function createFeeReader(client: PublicClient): FeeReader {
  return {
    async read(pool: PoolIdentity, position: OwnedPosition) {
      const [
        feeGrowthGlobal0X128,
        feeGrowthGlobal1X128,
        slot0,
        lowerTick,
        upperTick,
      ] = await Promise.all([
        client.readContract({
          address: pool.address,
          abi: POOL_FEE_STATE_ABI,
          functionName: 'feeGrowthGlobal0X128',
        }),
        client.readContract({
          address: pool.address,
          abi: POOL_FEE_STATE_ABI,
          functionName: 'feeGrowthGlobal1X128',
        }),
        client.readContract({
          address: pool.address,
          abi: POOL_FEE_STATE_ABI,
          functionName: 'slot0',
        }),
        client.readContract({
          address: pool.address,
          abi: POOL_FEE_STATE_ABI,
          functionName: 'ticks',
          args: [position.tickLower],
        }),
        client.readContract({
          address: pool.address,
          abi: POOL_FEE_STATE_ABI,
          functionName: 'ticks',
          args: [position.tickUpper],
        }),
      ]);

      const currentTick = slot0[1];
      const {feeGrowthInside0X128, feeGrowthInside1X128} =
        computeFeeGrowthInside(
          currentTick,
          position.tickLower,
          position.tickUpper,
          feeGrowthGlobal0X128,
          feeGrowthGlobal1X128,
          lowerTick[2],
          lowerTick[3],
          upperTick[2],
          upperTick[3],
        );

      return accruedFees(
        position.liquidity,
        feeGrowthInside0X128,
        feeGrowthInside1X128,
        position.feeGrowthInside0LastX128,
        position.feeGrowthInside1LastX128,
      );
    },
  };
}
