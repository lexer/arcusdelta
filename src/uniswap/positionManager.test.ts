import {describe, expect, it} from 'vitest';
import {encodeEventTopics, type Hex} from 'viem';
import {
  extractIncreaseLiquidity,
  POSITION_MANAGER_ABI,
} from './positionManager.js';

const POSITION_MANAGER = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
const OTHER_CONTRACT = '0x000000000000000000000000000000000000dEaD';

function increaseLiquidityLog(
  tokenId: bigint,
  liquidity: bigint,
  amount0: bigint,
  amount1: bigint,
  address: Hex = POSITION_MANAGER,
) {
  const topics = encodeEventTopics({
    abi: POSITION_MANAGER_ABI,
    eventName: 'IncreaseLiquidity',
    args: {tokenId},
  });
  return {
    address,
    topics,
    data: `0x${liquidity.toString(16).padStart(64, '0')}${amount0
      .toString(16)
      .padStart(64, '0')}${amount1.toString(16).padStart(64, '0')}` as Hex,
  };
}

describe('extractIncreaseLiquidity', () => {
  it('reads tokenId, liquidity, and amounts from the mint event', () => {
    const receipt = {
      logs: [increaseLiquidityLog(429580n, 196_440n, 31_679_634_696n, 64_420n)],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractIncreaseLiquidity(receipt as any, POSITION_MANAGER);

    expect(result).toEqual({
      tokenId: 429580n,
      liquidity: 196_440n,
      amount0: 31_679_634_696n,
      amount1: 64_420n,
    });
  });

  it('ignores logs from other contracts', () => {
    const receipt = {
      logs: [increaseLiquidityLog(1n, 1n, 1n, 1n, OTHER_CONTRACT)],
    };

    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractIncreaseLiquidity(receipt as any, POSITION_MANAGER),
    ).toBeUndefined();
  });

  it('returns undefined when no IncreaseLiquidity log was emitted', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractIncreaseLiquidity({logs: []} as any, POSITION_MANAGER),
    ).toBeUndefined();
  });

  it('skips logs it cannot decode against this ABI', () => {
    const receipt = {
      logs: [
        {
          address: POSITION_MANAGER,
          topics: ['0xdeadbeef'] as Hex[],
          data: '0x' as Hex,
        },
        increaseLiquidityLog(7n, 2n, 3n, 4n),
      ],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractIncreaseLiquidity(receipt as any, POSITION_MANAGER)).toEqual({
      tokenId: 7n,
      liquidity: 2n,
      amount0: 3n,
      amount1: 4n,
    });
  });
});
