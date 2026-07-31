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
  poolManager: '0x8366a39CC670B4001a1121b8F6a443A643E40951',
  positionManager: '0x58DaEC3116AAe6D93017bAaEa7749052E8a04Fa7',
  stateView: '0xf3334192D15450cDd385C8b70E03F9A6BD9E673b',
  quoter: '0x8dC178EFB8111Bb0973dD9d722EBEfF267c98F94',
  universalRouter: '0x8876789976DEcbfcbbBE364623c63652DB8c0904',
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
