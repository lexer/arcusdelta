/**
 * Uniswap v4 PoolKey construction and identity.
 *
 * A pool is identified entirely by its key. Getting any field wrong addresses
 * a different — possibly uninitialized — pool, so currency ordering is done
 * here once rather than at each call site.
 */

import {encodeAbiParameters, getAddress, keccak256, type Hex} from 'viem';
import {NO_HOOKS} from './deployments.js';

export interface PoolKey {
  readonly currency0: Hex;
  readonly currency1: Hex;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Hex;
}

export const POOL_KEY_ABI = [
  {name: 'currency0', type: 'address'},
  {name: 'currency1', type: 'address'},
  {name: 'fee', type: 'uint24'},
  {name: 'tickSpacing', type: 'int24'},
  {name: 'hooks', type: 'address'},
] as const;

/** v4 orders currencies by ascending address. */
export function orderCurrencies(a: Hex, b: Hex): [Hex, Hex] {
  const left = getAddress(a);
  const right = getAddress(b);
  return left.toLowerCase() < right.toLowerCase()
    ? [left, right]
    : [right, left];
}

export function createPoolKey(
  tokenA: Hex,
  tokenB: Hex,
  fee: number,
  tickSpacing: number,
  hooks: Hex = NO_HOOKS,
): PoolKey {
  if (getAddress(tokenA) === getAddress(tokenB)) {
    throw new Error(`A pool needs two distinct tokens, got ${tokenA} twice`);
  }
  const [currency0, currency1] = orderCurrencies(tokenA, tokenB);
  return {currency0, currency1, fee, tickSpacing, hooks};
}

/** keccak256 of the abi-encoded key, as PoolManager computes it. */
export function toPoolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI, [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

/** True when `token` sits in the currency0 slot of this key. */
export function isCurrency0(key: PoolKey, token: Hex): boolean {
  return getAddress(key.currency0) === getAddress(token);
}
