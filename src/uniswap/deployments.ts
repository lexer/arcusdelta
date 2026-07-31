/**
 * Uniswap v4 deployment addresses on Robinhood Chain mainnet.
 *
 * Every address below was verified to return contract code via eth_getCode
 * against https://rpc.mainnet.chain.robinhood.com, not taken from docs alone.
 */

import type {Hex} from 'viem';

export interface V4Deployment {
  readonly poolManager: Hex;
  readonly positionManager: Hex;
  readonly stateView: Hex;
  readonly quoter: Hex;
  readonly universalRouter: Hex;
  readonly permit2: Hex;
}

const ROBINHOOD_MAINNET: V4Deployment = {
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};

const BY_CHAIN_ID: ReadonlyMap<number, V4Deployment> = new Map([
  [4663, ROBINHOOD_MAINNET],
]);

export function getV4Deployment(chainId: number): V4Deployment {
  const deployment = BY_CHAIN_ID.get(chainId);
  if (!deployment) {
    throw new Error(`No Uniswap v4 deployment configured for chain ${chainId}`);
  }
  return deployment;
}

/** The zero address, used as the hooks slot for a pool with no hooks. */
export const NO_HOOKS: Hex = '0x0000000000000000000000000000000000000000';
