import {describe, expect, it} from 'vitest';
import {decodeAbiParameters, type Hex} from 'viem';
import {createPoolKey} from './poolKey.js';
import {
  ACTION_BURN_POSITION,
  ACTION_TAKE_PAIR,
  calculateMinimums,
  encodeCloseUnlockData,
  type CloseParams,
} from './positionCloser.js';
import type {OwnedPosition} from './positionReader.js';
import {getSqrtRatioAtTick} from './tickMath.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const OWNER = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';

// The live position: tokenId 422596, ticks [223080, 223740].
const position: OwnedPosition = {
  tokenId: 422596n,
  tickLower: 223080,
  tickUpper: 223740,
  liquidity: 60_210_398_382_745n,
};

const params: CloseParams = {
  tokenId: position.tokenId,
  poolKey: createPoolKey(USDG, NVDA, 3000, 60),
  amount0Min: 4_950_000n,
  amount1Min: 24_900_000_000_000_000n,
  recipient: OWNER,
};

const UNLOCK_DATA_ABI = [
  {name: 'actions', type: 'bytes'},
  {name: 'params', type: 'bytes[]'},
] as const;

const BURN_PARAMS_ABI = [
  {name: 'tokenId', type: 'uint256'},
  {name: 'amount0Min', type: 'uint128'},
  {name: 'amount1Min', type: 'uint128'},
  {name: 'hookData', type: 'bytes'},
] as const;

const TAKE_PAIR_PARAMS_ABI = [
  {name: 'currency0', type: 'address'},
  {name: 'currency1', type: 'address'},
  {name: 'recipient', type: 'address'},
] as const;

function decode(encoded: Hex) {
  const [actions, inner] = decodeAbiParameters(UNLOCK_DATA_ABI, encoded);
  return {actions, inner};
}

describe('encodeCloseUnlockData', () => {
  it('packs BURN_POSITION followed by TAKE_PAIR', () => {
    const {actions} = decode(encodeCloseUnlockData(params));

    expect(actions).toBe('0x0311');
    expect(ACTION_BURN_POSITION).toBe(0x03);
    expect(ACTION_TAKE_PAIR).toBe(0x11);
  });

  it('round-trips the burn parameters', () => {
    const {inner} = decode(encodeCloseUnlockData(params));
    const [tokenId, amount0Min, amount1Min, hookData] = decodeAbiParameters(
      BURN_PARAMS_ABI,
      inner[0]!,
    );

    expect(tokenId).toBe(422596n);
    expect(amount0Min).toBe(4_950_000n);
    expect(amount1Min).toBe(24_900_000_000_000_000n);
    expect(hookData).toBe('0x');
  });

  it('sends both currencies back to the owner', () => {
    const {inner} = decode(encodeCloseUnlockData(params));
    const [currency0, currency1, recipient] = decodeAbiParameters(
      TAKE_PAIR_PARAMS_ABI,
      inner[1]!,
    );

    expect(currency0).toBe(USDG);
    expect(currency1).toBe(NVDA);
    expect(recipient).toBe(OWNER);
  });

  it('emits one params entry per action', () => {
    expect(decode(encodeCloseUnlockData(params)).inner).toHaveLength(2);
  });

  it('changes when the token id changes', () => {
    expect(encodeCloseUnlockData(params)).not.toBe(
      encodeCloseUnlockData({...params, tokenId: 1n}),
    );
  });
});

describe('calculateMinimums', () => {
  it('discounts the in-range value by the slippage', () => {
    const inRange = getSqrtRatioAtTick(223400);

    const strict = calculateMinimums(position, inRange, 0);
    const loose = calculateMinimums(position, inRange, 100);

    expect(loose.amount0Min).toBeLessThan(strict.amount0Min);
    expect(loose.amount1Min).toBeLessThan(strict.amount1Min);
    expect(loose.amount0Min).toBe((strict.amount0Min * 9_900n) / 10_000n);
  });

  it('expects only USDG when the pool has fallen below the range', () => {
    const below = getSqrtRatioAtTick(position.tickLower - 100);

    const {amount0Min, amount1Min} = calculateMinimums(position, below, 100);

    expect(amount0Min).toBeGreaterThan(0n);
    expect(amount1Min).toBe(0n);
  });

  it('expects only the stock token when the pool has risen above the range', () => {
    const above = getSqrtRatioAtTick(position.tickUpper + 100);

    const {amount0Min, amount1Min} = calculateMinimums(position, above, 100);

    expect(amount0Min).toBe(0n);
    expect(amount1Min).toBeGreaterThan(0n);
  });

  it('expects both sides while the pool is inside the range', () => {
    const {amount0Min, amount1Min} = calculateMinimums(
      position,
      getSqrtRatioAtTick(223400),
      100,
    );

    expect(amount0Min).toBeGreaterThan(0n);
    expect(amount1Min).toBeGreaterThan(0n);
  });

  it('never demands more than the position is worth', () => {
    const price = getSqrtRatioAtTick(223400);

    const strict = calculateMinimums(position, price, 0);
    const discounted = calculateMinimums(position, price, 50);

    expect(discounted.amount0Min).toBeLessThanOrEqual(strict.amount0Min);
    expect(discounted.amount1Min).toBeLessThanOrEqual(strict.amount1Min);
  });
});
