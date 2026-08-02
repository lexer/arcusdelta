/**
 * Identifies a Uniswap v3 pool and resolves its live contract address.
 *
 * Unlike v4's singleton PoolManager, each v3 pool is its own contract. The
 * address always comes from a live `factory.getPool` call rather than being
 * computed offline via CREATE2 + init-code-hash: this deployment's exact init
 * code is not something to assume, and a live call cannot address the wrong
 * pool the way a hardcoded hash could.
 */

import {getAddress, type Hex, type PublicClient} from 'viem';
import {getV3Deployment} from './deployments.js';

export const FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      {name: 'tokenA', type: 'address'},
      {name: 'tokenB', type: 'address'},
      {name: 'fee', type: 'uint24'},
    ],
    outputs: [{type: 'address'}],
  },
  {
    type: 'function',
    name: 'feeAmountTickSpacing',
    stateMutability: 'view',
    inputs: [{name: 'fee', type: 'uint24'}],
    outputs: [{type: 'int24'}],
  },
] as const;

const NULL_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';

export interface PoolIdentity {
  readonly token0: Hex;
  readonly token1: Hex;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly address: Hex;
}

export class PoolNotCreatedError extends Error {
  constructor(
    readonly token0: Hex,
    readonly token1: Hex,
    readonly fee: number,
  ) {
    super(
      `No pool exists for (${token0}, ${token1}, fee=${fee}). ` +
        'Check POOL_FEE matches a pool the factory has created.',
    );
    this.name = 'PoolNotCreatedError';
  }
}

/** v3 orders tokens by ascending address. */
export function orderTokens(a: Hex, b: Hex): [Hex, Hex] {
  const left = getAddress(a);
  const right = getAddress(b);
  return left.toLowerCase() < right.toLowerCase()
    ? [left, right]
    : [right, left];
}

/**
 * Resolves the pool for a token pair and fee tier via the live factory.
 * Throws if the factory has never created that pool.
 */
export async function resolvePoolIdentity(
  client: PublicClient,
  chainId: number,
  tokenA: Hex,
  tokenB: Hex,
  fee: number,
): Promise<PoolIdentity> {
  if (getAddress(tokenA) === getAddress(tokenB)) {
    throw new Error(`A pool needs two distinct tokens, got ${tokenA} twice`);
  }
  const [token0, token1] = orderTokens(tokenA, tokenB);
  const factory = getV3Deployment(chainId).factory;

  const [address, tickSpacing] = await Promise.all([
    client.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [token0, token1, fee],
    }),
    client.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'feeAmountTickSpacing',
      args: [fee],
    }),
  ]);

  if (address === NULL_ADDRESS) {
    throw new PoolNotCreatedError(token0, token1, fee);
  }

  return {token0, token1, fee, tickSpacing, address};
}

/** True when `token` sits in the token0 slot of this pool. */
export function isToken0(identity: PoolIdentity, token: Hex): boolean {
  return getAddress(identity.token0) === getAddress(token);
}
