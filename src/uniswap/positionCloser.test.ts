import {describe, expect, it} from 'vitest';
import {decodeFunctionData} from 'viem';
import {
  calculateMinimums,
  CLOSE_ABI,
  encodeCloseCalls,
  type CloseParams,
} from './positionCloser.js';
import type {OwnedPosition} from './positionReader.js';
import {getSqrtRatioAtTick} from './tickMath.js';

const OWNER = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';

// The live position that was actually closed under v4, tokenId 429580 shape.
const position: OwnedPosition = {
  tokenId: 429580n,
  tickLower: 218880,
  tickUpper: 219180,
  liquidity: 196_440_212_530_173_869n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
};

const params: CloseParams = {
  tokenId: position.tokenId,
  liquidity: position.liquidity,
  amount0Min: 31_362_838_349n,
  amount1Min: 63_775_975_463_635_989_582n,
  recipient: OWNER,
};

const DEADLINE = 1_800_000_000n;

describe('encodeCloseCalls', () => {
  it('bundles exactly a decrease and a collect', () => {
    const calls = encodeCloseCalls(params, DEADLINE);

    expect(calls).toHaveLength(2);
  });

  it('decreases the full liquidity with the given minimums', () => {
    const calls = encodeCloseCalls(params, DEADLINE);
    const {functionName, args} = decodeFunctionData({
      abi: CLOSE_ABI,
      data: calls[0]!,
    });

    expect(functionName).toBe('decreaseLiquidity');
    expect(args[0]).toEqual({
      tokenId: 429580n,
      liquidity: 196_440_212_530_173_869n,
      amount0Min: 31_362_838_349n,
      amount1Min: 63_775_975_463_635_989_582n,
      deadline: DEADLINE,
    });
  });

  it('collects everything owed to the owner', () => {
    const calls = encodeCloseCalls(params, DEADLINE);
    const {functionName, args} = decodeFunctionData({
      abi: CLOSE_ABI,
      data: calls[1]!,
    });

    expect(functionName).toBe('collect');
    expect(args[0]).toEqual({
      tokenId: 429580n,
      recipient: OWNER,
      amount0Max: 2n ** 128n - 1n,
      amount1Max: 2n ** 128n - 1n,
    });
  });

  it('is deterministic', () => {
    expect(encodeCloseCalls(params, DEADLINE)).toEqual(
      encodeCloseCalls(params, DEADLINE),
    );
  });

  it('changes when the token id changes', () => {
    expect(encodeCloseCalls(params, DEADLINE)).not.toEqual(
      encodeCloseCalls({...params, tokenId: 1n}, DEADLINE),
    );
  });
});

describe('calculateMinimums', () => {
  const inRange = getSqrtRatioAtTick(219000);

  it('discounts the in-range value by the slippage', () => {
    const strict = calculateMinimums(position, inRange, 0);
    const loose = calculateMinimums(position, inRange, 100);

    expect(loose.amount0Min).toBeLessThan(strict.amount0Min);
    expect(loose.amount1Min).toBeLessThan(strict.amount1Min);
    expect(loose.amount0Min).toBe((strict.amount0Min * 9_900n) / 10_000n);
  });

  it('expects only token0 when the pool has fallen below the range', () => {
    const below = getSqrtRatioAtTick(position.tickLower - 100);

    const {amount0Min, amount1Min} = calculateMinimums(position, below, 100);

    expect(amount0Min).toBeGreaterThan(0n);
    expect(amount1Min).toBe(0n);
  });

  it('expects only token1 when the pool has risen above the range', () => {
    const above = getSqrtRatioAtTick(position.tickUpper + 100);

    const {amount0Min, amount1Min} = calculateMinimums(position, above, 100);

    expect(amount0Min).toBe(0n);
    expect(amount1Min).toBeGreaterThan(0n);
  });

  it('expects both sides while the pool is inside the range', () => {
    const {amount0Min, amount1Min} = calculateMinimums(position, inRange, 100);

    expect(amount0Min).toBeGreaterThan(0n);
    expect(amount1Min).toBeGreaterThan(0n);
  });
});
