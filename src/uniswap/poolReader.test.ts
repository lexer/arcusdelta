import {describe, expect, it, vi} from 'vitest';
import {createPoolReader, PoolNotInitializedError} from './poolReader.js';
import type {PoolIdentity} from './poolAddress.js';

const IDENTITY: PoolIdentity = {
  token0: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  token1: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  fee: 3000,
  tickSpacing: 60,
  // The live USDG/NVDA pool.
  address: '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B',
};

function harness(sqrtPriceX96: bigint, tick = 223347, liquidity = 1_000n) {
  const readContract = vi.fn(({functionName}) => {
    if (functionName === 'slot0') {
      return Promise.resolve([
        sqrtPriceX96,
        tick,
        0,
        1,
        1,
        0,
        true,
      ] as const);
    }
    if (functionName === 'liquidity') return Promise.resolve(liquidity);
    throw new Error(`unexpected ${functionName}`);
  });
  return {reader: createPoolReader({readContract} as never), readContract};
}

describe('readState', () => {
  it('reads slot0 and liquidity from the pool address directly', async () => {
    const {reader, readContract} = harness(5_630_988_710_377_423_664_134_631_725_262_565n);

    const state = await reader.readState(IDENTITY);

    expect(state.poolAddress).toBe(IDENTITY.address);
    expect(state.tick).toBe(223347);
    expect(state.liquidity).toBe(1_000n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({address: IDENTITY.address, functionName: 'slot0'}),
    );
  });

  it('rejects a pool that was never initialized', async () => {
    const {reader} = harness(0n);

    await expect(reader.readState(IDENTITY)).rejects.toThrow(
      PoolNotInitializedError,
    );
  });
});
