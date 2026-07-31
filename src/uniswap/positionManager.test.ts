import {describe, expect, it} from 'vitest';
import {decodeAbiParameters, encodeAbiParameters, type Hex} from 'viem';
import {createPoolKey, POOL_KEY_ABI} from './poolKey.js';
import {
  ACTION_MINT_POSITION,
  ACTION_SETTLE_PAIR,
  encodeMintUnlockData,
  extractMintedTokenId,
  type MintParams,
} from './positionManager.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const RECIPIENT = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';

const params: MintParams = {
  poolKey: createPoolKey(USDG, NVDA, 3000, 60),
  tickLower: 223140,
  tickUpper: 223740,
  liquidity: 1_234_567_890n,
  amount0Max: 5_025_000n,
  amount1Max: 25_304_292_619_238_058n,
  recipient: RECIPIENT,
};

const UNLOCK_DATA_ABI = [
  {name: 'actions', type: 'bytes'},
  {name: 'params', type: 'bytes[]'},
] as const;

const MINT_PARAMS_ABI = [
  {name: 'poolKey', type: 'tuple', components: POOL_KEY_ABI},
  {name: 'tickLower', type: 'int24'},
  {name: 'tickUpper', type: 'int24'},
  {name: 'liquidity', type: 'uint256'},
  {name: 'amount0Max', type: 'uint128'},
  {name: 'amount1Max', type: 'uint128'},
  {name: 'recipient', type: 'address'},
  {name: 'hookData', type: 'bytes'},
] as const;

function decode(encoded: Hex) {
  const [actions, inner] = decodeAbiParameters(UNLOCK_DATA_ABI, encoded);
  return {actions, inner};
}

describe('encodeMintUnlockData', () => {
  it('packs MINT_POSITION followed by SETTLE_PAIR', () => {
    const {actions} = decode(encodeMintUnlockData(params));

    expect(actions).toBe('0x020d');
    expect(ACTION_MINT_POSITION).toBe(0x02);
    expect(ACTION_SETTLE_PAIR).toBe(0x0d);
  });

  it('emits exactly one params entry per action', () => {
    const {inner} = decode(encodeMintUnlockData(params));

    expect(inner).toHaveLength(2);
  });

  it('round-trips the mint parameters', () => {
    const {inner} = decode(encodeMintUnlockData(params));

    const [
      poolKey,
      tickLower,
      tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
      recipient,
      hookData,
    ] = decodeAbiParameters(MINT_PARAMS_ABI, inner[0]!);

    expect(poolKey.currency0).toBe(USDG);
    expect(poolKey.currency1).toBe(NVDA);
    expect(poolKey.fee).toBe(3000);
    expect(poolKey.tickSpacing).toBe(60);
    expect(tickLower).toBe(223140);
    expect(tickUpper).toBe(223740);
    expect(liquidity).toBe(1_234_567_890n);
    expect(amount0Max).toBe(5_025_000n);
    expect(amount1Max).toBe(25_304_292_619_238_058n);
    expect(recipient).toBe(RECIPIENT);
    expect(hookData).toBe('0x');
  });

  it('settles the same currencies the pool key names, in order', () => {
    const {inner} = decode(encodeMintUnlockData(params));

    const [currency0, currency1] = decodeAbiParameters(
      [
        {name: 'currency0', type: 'address'},
        {name: 'currency1', type: 'address'},
      ],
      inner[1]!,
    );

    expect(currency0).toBe(USDG);
    expect(currency1).toBe(NVDA);
  });

  it('encodes negative ticks correctly', () => {
    const encoded = encodeMintUnlockData({
      ...params,
      tickLower: -1200,
      tickUpper: -600,
    });
    const {inner} = decode(encoded);
    const [, tickLower, tickUpper] = decodeAbiParameters(
      MINT_PARAMS_ABI,
      inner[0]!,
    );

    expect(tickLower).toBe(-1200);
    expect(tickUpper).toBe(-600);
  });
});

describe('extractMintedTokenId', () => {
  const positionManager = '0x58DaEC3116AAe6D93017bAaEa7749052E8a04Fa7';
  const transferTopic =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  function transferLog(to: Hex, id: bigint, address = positionManager) {
    return {
      address,
      data: '0x' as Hex,
      topics: [
        transferTopic,
        `0x${'0'.repeat(64)}`,
        `0x${to.slice(2).toLowerCase().padStart(64, '0')}`,
        `0x${id.toString(16).padStart(64, '0')}`,
      ] as [Hex, Hex, Hex, Hex],
    };
  }

  it('reads the token id from the mint transfer', () => {
    const receipt = {logs: [transferLog(RECIPIENT, 4242n)]};

    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractMintedTokenId(receipt as any, positionManager, RECIPIENT),
    ).toBe(4242n);
  });

  it('ignores logs from other contracts', () => {
    const receipt = {
      logs: [
        transferLog(
          RECIPIENT,
          99n,
          '0x000000000000000000000000000000000000dEaD',
        ),
      ],
    };

    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractMintedTokenId(receipt as any, positionManager, RECIPIENT),
    ).toBeUndefined();
  });

  it('ignores transfers to another recipient', () => {
    const receipt = {
      logs: [transferLog('0x000000000000000000000000000000000000bEEF', 7n)],
    };

    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractMintedTokenId(receipt as any, positionManager, RECIPIENT),
    ).toBeUndefined();
  });

  it('returns undefined when no transfer was emitted', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractMintedTokenId({logs: []} as any, positionManager, RECIPIENT),
    ).toBeUndefined();
  });
});

describe('encoding stability', () => {
  it('is deterministic', () => {
    expect(encodeMintUnlockData(params)).toBe(encodeMintUnlockData(params));
  });

  it('changes when the range changes', () => {
    expect(encodeMintUnlockData(params)).not.toBe(
      encodeMintUnlockData({...params, tickLower: 223080}),
    );
  });

  it('is a valid abi-encoded pair', () => {
    expect(() =>
      decodeAbiParameters(UNLOCK_DATA_ABI, encodeMintUnlockData(params)),
    ).not.toThrow();
    expect(encodeAbiParameters).toBeDefined();
  });
});
