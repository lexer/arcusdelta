/**
 * Robinhood Chain definition.
 *
 * viem ships a verified definition for chain 4663 (native currency, explorer,
 * multicall3); we only swap in the operator-configured RPC endpoint.
 */

import type {Chain} from 'viem';
import {robinhood} from 'viem/chains';

export const ROBINHOOD_MAINNET_CHAIN_ID = robinhood.id;

export function createRobinhoodChain(rpcUrl: string, chainId: number): Chain {
  if (chainId !== robinhood.id) {
    throw new Error(
      `Unsupported CHAIN_ID ${chainId}: this bot targets Robinhood Chain mainnet (${robinhood.id})`,
    );
  }
  return {...robinhood, rpcUrls: {default: {http: [rpcUrl]}}};
}
