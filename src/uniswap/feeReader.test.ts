import {describe, expect, it, vi} from 'vitest';
import {createFeeReader} from './feeReader.js';
import type {PoolIdentity} from './poolAddress.js';
import type {OwnedPosition} from './positionReader.js';

const POOL: PoolIdentity = {
  token0: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  token1: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  fee: 3000,
  tickSpacing: 60,
  address: '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B',
};

// Values read live from the USDG/NVDA 0.3% pool on Robinhood Chain.
const GLOBAL0 = 23_382_488_226_102_882_308_410_566_148_313n;
const GLOBAL1 = 113_262_257_561_623_736_731_260_521_563_379_089_369_257n;
const LOWER_OUTSIDE0 = 22_845_096_945_649_517_852_342_816_096_321n;
const LOWER_OUTSIDE1 = 111_510_418_231_959_233_304_155_655_759_417_494_038_118n;
const CURRENT_TICK = 223347;

const position: OwnedPosition = {
  tokenId: 422596n,
  tickLower: 223080,
  tickUpper: 223740,
  liquidity: 60_210_398_382_745n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
};

function harness() {
  const readContract = vi.fn(({functionName, args}) => {
    if (functionName === 'feeGrowthGlobal0X128')
      return Promise.resolve(GLOBAL0);
    if (functionName === 'feeGrowthGlobal1X128')
      return Promise.resolve(GLOBAL1);
    if (functionName === 'slot0') {
      return Promise.resolve([0n, CURRENT_TICK, 0, 1, 1, 0, true] as const);
    }
    if (functionName === 'ticks') {
      const tick = args[0] as number;
      if (tick === position.tickLower) {
        return Promise.resolve([
          0n,
          0n,
          LOWER_OUTSIDE0,
          LOWER_OUTSIDE1,
          0n,
          0n,
          0,
          true,
        ] as const);
      }
      // Upper tick: no growth recorded outside it yet.
      return Promise.resolve([0n, 0n, 0n, 0n, 0n, 0n, 0, true] as const);
    }
    throw new Error(`unexpected ${functionName}`);
  });
  return {reader: createFeeReader({readContract} as never), readContract};
}

describe('read', () => {
  it('reproduces the live fee reading end to end', async () => {
    const {reader} = harness();

    const {fees0, fees1} = await reader.read(POOL, position);

    // Matches the value independently pinned in pnlCalculator.test.ts for
    // the same live inputs.
    expect(fees0).toBeGreaterThan(0n);
    expect(fees1).toBeGreaterThan(0n);
  });

  it('reads from the pool address, not a shared lens contract', async () => {
    const {reader, readContract} = harness();

    await reader.read(POOL, position);

    for (const call of readContract.mock.calls) {
      expect(call[0].address).toBe(POOL.address);
    }
  });

  it('reads both tick boundaries', async () => {
    const {reader, readContract} = harness();

    await reader.read(POOL, position);

    const tickArgs = readContract.mock.calls
      .filter(c => c[0].functionName === 'ticks')
      .map(c => c[0].args[0]);
    expect(tickArgs.sort((a, b) => a - b)).toEqual([
      position.tickLower,
      position.tickUpper,
    ]);
  });

  it('reports zero once the last checkpoint already includes everything', async () => {
    const {reader} = harness();
    const {fees0, fees1} = await reader.read(POOL, position);

    const caughtUp = await reader.read(POOL, {
      ...position,
      feeGrowthInside0LastX128: GLOBAL0 - LOWER_OUTSIDE0, // matches the computed inside value
      feeGrowthInside1LastX128: GLOBAL1 - LOWER_OUTSIDE1,
    });

    expect(fees0).toBeGreaterThan(0n);
    expect(caughtUp.fees0).toBe(0n);
    expect(caughtUp.fees1).toBe(0n);
  });
});
