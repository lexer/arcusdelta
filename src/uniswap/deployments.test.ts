import {describe, expect, it} from 'vitest';
import {getAddress} from 'viem';
import {getV3Deployment} from './deployments.js';

describe('getV3Deployment', () => {
  it('returns the Robinhood Chain mainnet deployment', () => {
    const deployment = getV3Deployment(4663);

    expect(deployment.factory).toBeDefined();
    expect(deployment.positionManager).toBeDefined();
  });

  it('stores every address in valid checksum form', () => {
    // viem rejects a mis-checksummed address at call time, so catch it here
    // rather than against the live chain. v4's documented addresses failed
    // this exact check.
    for (const [name, address] of Object.entries(getV3Deployment(4663))) {
      expect(() => getAddress(address), name).not.toThrow();
      expect(address, name).toBe(getAddress(address));
    }
  });

  it('rejects a chain with no deployment', () => {
    expect(() => getV3Deployment(1)).toThrow(/no uniswap v3 deployment/i);
  });
});
