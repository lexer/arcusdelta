import {describe, expect, it} from 'vitest';
import {
  createRobinhoodChain,
  ROBINHOOD_MAINNET_CHAIN_ID,
} from './robinhoodChain.js';
import {createWalletProvider} from './walletProvider.js';

// Public test mnemonic used across the Ethereum tooling ecosystem. Never a real wallet.
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

describe('createRobinhoodChain', () => {
  it('uses the configured rpc url', () => {
    const chain = createRobinhoodChain(RPC_URL, ROBINHOOD_MAINNET_CHAIN_ID);

    expect(chain.id).toBe(4663);
    expect(chain.rpcUrls.default.http[0]).toBe(RPC_URL);
    expect(chain.nativeCurrency.decimals).toBe(18);
  });

  it('rejects a chain id other than Robinhood mainnet', () => {
    expect(() => createRobinhoodChain(RPC_URL, 46630)).toThrow(/46630/);
  });
});

describe('createWalletProvider', () => {
  it('derives the expected account from a mnemonic', () => {
    const chain = createRobinhoodChain(RPC_URL, ROBINHOOD_MAINNET_CHAIN_ID);
    const provider = createWalletProvider(TEST_MNEMONIC, chain, RPC_URL);

    expect(provider.getAccount().address).toBe(TEST_ADDRESS);
  });

  it('binds both clients to the chain', () => {
    const chain = createRobinhoodChain(RPC_URL, ROBINHOOD_MAINNET_CHAIN_ID);
    const provider = createWalletProvider(TEST_MNEMONIC, chain, RPC_URL);

    expect(provider.getWalletClient().chain?.id).toBe(4663);
    expect(provider.getPublicClient().chain?.id).toBe(4663);
  });
});
