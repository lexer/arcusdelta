import {describe, expect, it, vi} from 'vitest';
import {createPositionReader} from './positionReader.js';
import type {PoolIdentity} from './poolAddress.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const OTHER = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
const OWNER = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';
const STRANGER = '0x000000000000000000000000000000000000bEEF';

const POOL: PoolIdentity = {
  token0: USDG,
  token1: NVDA,
  fee: 3000,
  tickSpacing: 60,
  address: '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B',
};

interface FakePosition {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  owner?: string;
}

function positionsTuple(p: FakePosition) {
  return [
    0n,
    '0x00000000000000000000000000000000000000',
    p.token0,
    p.token1,
    p.fee,
    p.tickLower,
    p.tickUpper,
    p.liquidity,
    111n,
    222n,
    0n,
    0n,
  ] as const;
}

function harness(
  byTokenId: Record<string, FakePosition>,
  ownerTokenIds: bigint[],
) {
  const readContract = vi.fn(({functionName, args}) => {
    if (functionName === 'balanceOf') {
      return Promise.resolve(BigInt(ownerTokenIds.length));
    }
    if (functionName === 'tokenOfOwnerByIndex') {
      return Promise.resolve(ownerTokenIds[Number(args[1])]);
    }
    if (functionName === 'positions') {
      const p = byTokenId[String(args[0])];
      if (!p) return Promise.reject(new Error('not minted'));
      return Promise.resolve(positionsTuple(p));
    }
    if (functionName === 'ownerOf') {
      const p = byTokenId[String(args[0])];
      if (!p) return Promise.reject(new Error('not minted'));
      return Promise.resolve(p.owner ?? OWNER);
    }
    return Promise.reject(new Error(`unexpected ${functionName}`));
  });

  return {
    reader: createPositionReader({readContract} as never, 4663),
    readContract,
  };
}

const live: FakePosition = {
  token0: USDG,
  token1: NVDA,
  fee: 3000,
  tickLower: 223080,
  tickUpper: 223740,
  liquidity: 60_210_398_382_745n,
};

describe('discover', () => {
  it('returns positions the wallet holds in the configured pool', async () => {
    const {reader} = harness({'422596': live}, [422596n]);

    const found = await reader.discover(POOL, OWNER);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      tokenId: 422596n,
      tickLower: 223080,
      tickUpper: 223740,
      liquidity: 60_210_398_382_745n,
    });
  });

  it('needs no block range: only balanceOf + tokenOfOwnerByIndex + positions', async () => {
    const {reader, readContract} = harness({'422596': live}, [422596n]);

    await reader.discover(POOL, OWNER);

    const calledFunctions = readContract.mock.calls.map(c => c[0].functionName);
    expect(calledFunctions).not.toContain('getLogs');
    expect(calledFunctions.sort()).toEqual(
      ['balanceOf', 'positions', 'tokenOfOwnerByIndex'].sort(),
    );
  });

  it('ignores positions in a different pool', async () => {
    const {reader} = harness({'99': {...live, token1: OTHER}}, [99n]);

    expect(await reader.discover(POOL, OWNER)).toEqual([]);
  });

  it('ignores positions with no liquidity left', async () => {
    const {reader} = harness({'99': {...live, liquidity: 0n}}, [99n]);

    expect(await reader.discover(POOL, OWNER)).toEqual([]);
  });

  it('separates the wallet own positions from unrelated ones', async () => {
    const {reader} = harness(
      {
        '1': live,
        '2': {...live, token1: OTHER},
        '3': {...live, liquidity: 0n},
      },
      [1n, 2n, 3n],
    );

    const found = await reader.discover(POOL, OWNER);

    expect(found.map(p => p.tokenId)).toEqual([1n]);
  });

  it('discovers multiple positions in the same pool', async () => {
    const {reader} = harness(
      {'1': live, '2': {...live, tickLower: 0, tickUpper: 60}},
      [1n, 2n],
    );

    const found = await reader.discover(POOL, OWNER);

    expect(found.map(p => p.tokenId).sort()).toEqual([1n, 2n]);
  });

  it('returns nothing for a wallet that holds no positions', async () => {
    const {reader} = harness({}, []);

    expect(await reader.discover(POOL, OWNER)).toEqual([]);
  });
});

describe('read', () => {
  it('returns undefined for a position in another pool', async () => {
    const {reader} = harness({'7': {...live, token1: OTHER}}, []);

    expect(await reader.read(7n, POOL)).toBeUndefined();
  });

  it('returns the position when everything matches', async () => {
    const {reader} = harness(
      {'7': {...live, tickLower: 120, tickUpper: 180}},
      [],
    );

    expect(await reader.read(7n, POOL)).toMatchObject({
      tokenId: 7n,
      tickLower: 120,
      tickUpper: 180,
    });
  });

  it('returns undefined for a burned or never-minted token', async () => {
    const {reader} = harness({}, []);

    expect(await reader.read(999n, POOL)).toBeUndefined();
  });

  it('checks ownership when an owner is supplied', async () => {
    const {reader} = harness({'7': {...live, owner: STRANGER}}, []);

    expect(await reader.read(7n, POOL, OWNER)).toBeUndefined();
  });

  it('accepts a position the wallet actually owns', async () => {
    const {reader} = harness({'7': {...live, owner: OWNER}}, []);

    expect(await reader.read(7n, POOL, OWNER)).toMatchObject({tokenId: 7n});
  });

  it('rejects a mismatched pool key even when only the fee differs', async () => {
    const {reader} = harness({'7': {...live, fee: 500}}, []);

    expect(await reader.read(7n, POOL)).toBeUndefined();
  });
});
