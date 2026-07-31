import {describe, expect, it} from 'vitest';
import {getAddress} from 'viem';
import {getV4Deployment, NO_HOOKS} from './deployments.js';

describe('getV4Deployment', () => {
  it('returns the Robinhood Chain mainnet deployment', () => {
    const deployment = getV4Deployment(4663);

    expect(deployment.poolManager).toBeDefined();
    expect(deployment.permit2).toBe(
      '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    );
  });

  it('stores every address in valid checksum form', () => {
    // viem rejects a mis-checksummed address at call time, so catch it here
    // rather than against the live chain.
    for (const [name, address] of Object.entries(getV4Deployment(4663))) {
      expect(() => getAddress(address), name).not.toThrow();
      expect(address, name).toBe(getAddress(address));
    }
  });

  it('rejects a chain with no deployment', () => {
    expect(() => getV4Deployment(1)).toThrow(/no uniswap v4 deployment/i);
  });
});

describe('NO_HOOKS', () => {
  it('is the zero address', () => {
    expect(NO_HOOKS).toBe('0x0000000000000000000000000000000000000000');
  });
});
