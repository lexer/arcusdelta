import {describe, expect, it} from 'vitest';
import {
  createPoolKey,
  isCurrency0,
  orderCurrencies,
  toPoolId,
} from './poolKey.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';

describe('orderCurrencies', () => {
  it('sorts by ascending address regardless of input order', () => {
    expect(orderCurrencies(USDG, NVDA)).toEqual([USDG, NVDA]);
    expect(orderCurrencies(NVDA, USDG)).toEqual([USDG, NVDA]);
  });

  it('checksums the result', () => {
    const [first] = orderCurrencies(USDG.toLowerCase() as `0x${string}`, NVDA);
    expect(first).toBe(USDG);
  });
});

describe('createPoolKey', () => {
  it('puts USDG in the currency0 slot for this pair', () => {
    const key = createPoolKey(NVDA, USDG, 3000, 60);

    expect(key.currency0).toBe(USDG);
    expect(key.currency1).toBe(NVDA);
    expect(key.hooks).toBe('0x0000000000000000000000000000000000000000');
  });

  it('rejects a pool of a token with itself', () => {
    expect(() => createPoolKey(USDG, USDG, 3000, 60)).toThrow();
  });
});

describe('toPoolId', () => {
  it('reproduces the live pool id observed on chain', () => {
    // Confirmed initialized via StateView on Robinhood Chain: this is the
    // USDG/NVDA 0.3% pool at tick 223440.
    const key = createPoolKey(USDG, NVDA, 3000, 60);

    expect(toPoolId(key).slice(0, 18)).toBe('0x3bb34a44f1b2b5f3');
  });

  it('distinguishes pools that differ only by fee tier', () => {
    const three = toPoolId(createPoolKey(USDG, NVDA, 3000, 60));
    const five = toPoolId(createPoolKey(USDG, NVDA, 500, 10));

    expect(three).not.toBe(five);
  });

  it('distinguishes pools that differ only by tick spacing', () => {
    const sixty = toPoolId(createPoolKey(USDG, NVDA, 3000, 60));
    const ten = toPoolId(createPoolKey(USDG, NVDA, 3000, 10));

    expect(sixty).not.toBe(ten);
  });

  it('is independent of the order the tokens were supplied in', () => {
    expect(toPoolId(createPoolKey(USDG, NVDA, 3000, 60))).toBe(
      toPoolId(createPoolKey(NVDA, USDG, 3000, 60)),
    );
  });
});

describe('isCurrency0', () => {
  it('identifies which slot a token occupies', () => {
    const key = createPoolKey(USDG, NVDA, 3000, 60);

    expect(isCurrency0(key, USDG)).toBe(true);
    expect(isCurrency0(key, NVDA)).toBe(false);
    expect(isCurrency0(key, USDG.toLowerCase() as `0x${string}`)).toBe(true);
  });
});
