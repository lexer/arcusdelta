/**
 * Derives the production wallet and the viem clients used to sign and read.
 *
 * Invariant: the mnemonic is used only to derive the account. Neither it nor
 * the derived private key is ever logged or returned.
 */

import {createPublicClient, createWalletClient, http} from 'viem';
import type {Account, Chain, HDAccount, PublicClient, WalletClient} from 'viem';
import {mnemonicToAccount} from 'viem/accounts';

export interface WalletProvider {
  getAccount(): Account;
  getWalletClient(): WalletClient;
  getPublicClient(): PublicClient;
}

export function createWalletProvider(
  mnemonic: string,
  chain: Chain,
  rpcUrl: string,
): WalletProvider {
  const account: HDAccount = mnemonicToAccount(mnemonic);
  const transport = http(rpcUrl);
  const walletClient = createWalletClient({account, chain, transport});
  const publicClient = createPublicClient({chain, transport});

  return {
    getAccount: () => account,
    getWalletClient: () => walletClient,
    getPublicClient: () => publicClient as PublicClient,
  };
}
