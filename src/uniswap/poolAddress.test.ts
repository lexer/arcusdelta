import {describe, expect, it, vi} from 'vitest';
import {
  isToken0,
  orderTokens,
  PoolNotCreatedError,
  resolvePoolIdentity,
} from './poolAddress.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const ZERO = '0x0000000000000000000000000000000000000000';

// Live on Robinhood Chain: USDG/NVDA fee 3000.
const NVDA_POOL = '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B';

describe('orderTokens', () => {
  it('sorts by ascending address regardless of input order', () => {
    expect(orderTokens(USDG, NVDA)).toEqual([USDG, NVDA]);
    expect(orderTokens(NVDA, USDG)).toEqual([USDG, NVDA]);
  });

  it('checksums the result', () => {
    const [first] = orderTokens(USDG.toLowerCase() as `0x${string}`, NVDA);
    expect(first).toBe(USDG);
  });
});

function harness(poolAddress: string, tickSpacing = 60) {
  const readContract = vi.fn(({functionName}) => {
    if (functionName === 'getPool') return Promise.resolve(poolAddress);
    if (functionName === 'feeAmountTickSpacing') {
      return Promise.resolve(tickSpacing);
    }
    throw new Error(`unexpected ${functionName}`);
  });
  return {readContract, client: {readContract} as never};
}

describe('resolvePoolIdentity', () => {
  it('reproduces the live USDG/NVDA pool address', async () => {
    const {client} = harness(NVDA_POOL);

    const identity = await resolvePoolIdentity(client, 4663, NVDA, USDG, 3000);

    expect(identity.address).toBe(NVDA_POOL);
    expect(identity.token0).toBe(USDG);
    expect(identity.token1).toBe(NVDA);
    expect(identity.tickSpacing).toBe(60);
  });

  it('queries the factory with tokens already sorted', async () => {
    const {client, readContract} = harness(NVDA_POOL);

    await resolvePoolIdentity(client, 4663, NVDA, USDG, 3000);

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'getPool',
        args: [USDG, NVDA, 3000],
      }),
    );
  });

  it('is independent of the order the tokens were supplied in', async () => {
    const {client: c1} = harness(NVDA_POOL);
    const {client: c2} = harness(NVDA_POOL);

    const a = await resolvePoolIdentity(c1, 4663, USDG, NVDA, 3000);
    const b = await resolvePoolIdentity(c2, 4663, NVDA, USDG, 3000);

    expect(a).toEqual(b);
  });

  it('rejects when the factory has never created the pool', async () => {
    const {client} = harness(ZERO);

    await expect(
      resolvePoolIdentity(client, 4663, USDG, AAPL, 10000),
    ).rejects.toThrow(PoolNotCreatedError);
  });

  it('rejects a pool of a token with itself', async () => {
    const {client} = harness(NVDA_POOL);

    await expect(
      resolvePoolIdentity(client, 4663, USDG, USDG, 3000),
    ).rejects.toThrow();
  });

  it('reads the real tickSpacing for each fee tier', async () => {
    for (const [fee, spacing] of [
      [100, 1],
      [500, 10],
      [3000, 60],
      [10000, 200],
    ] as const) {
      const {client} = harness(NVDA_POOL, spacing);
      const identity = await resolvePoolIdentity(client, 4663, USDG, NVDA, fee);
      expect(identity.tickSpacing).toBe(spacing);
    }
  });
});

describe('isToken0', () => {
  it('identifies which slot a token occupies', async () => {
    const {client} = harness(NVDA_POOL);
    const identity = await resolvePoolIdentity(client, 4663, USDG, NVDA, 3000);

    expect(isToken0(identity, USDG)).toBe(true);
    expect(isToken0(identity, NVDA)).toBe(false);
    expect(isToken0(identity, USDG.toLowerCase() as `0x${string}`)).toBe(true);
  });
});
