/**
 * Uniswap v3 deployment addresses on Robinhood Chain mainnet.
 *
 * Every address below was verified to return contract code via eth_getCode
 * against https://rpc.mainnet.chain.robinhood.com, not taken from docs alone.
 */

import type {Hex} from 'viem';

export interface V3Deployment {
  readonly factory: Hex;
  readonly positionManager: Hex;
  readonly swapRouter02: Hex;
  readonly quoterV2: Hex;
}

const ROBINHOOD_MAINNET: V3Deployment = {
  factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2',
  quoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
};

const BY_CHAIN_ID: ReadonlyMap<number, V3Deployment> = new Map([
  [4663, ROBINHOOD_MAINNET],
]);

export function getV3Deployment(chainId: number): V3Deployment {
  const deployment = BY_CHAIN_ID.get(chainId);
  if (!deployment) {
    throw new Error(`No Uniswap v3 deployment configured for chain ${chainId}`);
  }
  return deployment;
}
