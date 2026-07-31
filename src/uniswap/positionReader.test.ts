import {describe, expect, it, vi} from 'vitest';
import {pino} from 'pino';
import {createPoolKey} from './poolKey.js';
import {createPositionReader, decodePositionTicks} from './positionReader.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const OTHER = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
const OWNER = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';
const STRANGER = '0x000000000000000000000000000000000000bEEF';

const POOL = createPoolKey(USDG, NVDA, 3000, 60);
const OTHER_POOL = createPoolKey(USDG, OTHER, 3000, 60);

/** Packs ticks the way PositionInfoLibrary does. */
function packInfo(tickLower: number, tickUpper: number): bigint {
  const lower = BigInt.asUintN(24, BigInt(tickLower));
  const upper = BigInt.asUintN(24, BigInt(tickUpper));
  return (upper << 32n) | (lower << 8n);
}

interface FakePosition {
  owner: string;
  liquidity: bigint;
  poolKey: ReturnType<typeof createPoolKey>;
  info: bigint;
}

function harness(positions: Record<string, FakePosition>, transfers: bigint[]) {
  const readContract = vi.fn(({functionName, args}) => {
    const tokenId = String(args[0]);
    const position = positions[tokenId];
    if (!position) return Promise.reject(new Error('NOT_MINTED'));
    if (functionName === 'ownerOf') return Promise.resolve(position.owner);
    if (functionName === 'getPositionLiquidity') {
      return Promise.resolve(position.liquidity);
    }
    if (functionName === 'getPoolAndPositionInfo') {
      return Promise.resolve([position.poolKey, position.info]);
    }
    return Promise.reject(new Error(`unexpected ${functionName}`));
  });

  const client = {
    getBlockNumber: vi.fn().mockResolvedValue(1_000_000n),
    getLogs: vi
      .fn()
      .mockResolvedValue(transfers.map(id => ({args: {id, to: OWNER}}))),
    readContract,
  };

  return {
    reader: createPositionReader(
      client as never,
      4663,
      60_000,
      pino({level: 'silent'}),
    ),
    client,
  };
}

describe('decodePositionTicks', () => {
  it('decodes the live position bounds', () => {
    // tokenId 422596 on Robinhood Chain.
    expect(decodePositionTicks(packInfo(223080, 223740))).toEqual({
      tickLower: 223080,
      tickUpper: 223740,
    });
  });

  it('decodes negative ticks', () => {
    expect(decodePositionTicks(packInfo(-1200, -600))).toEqual({
      tickLower: -1200,
      tickUpper: -600,
    });
  });

  it('decodes a range straddling zero', () => {
    expect(decodePositionTicks(packInfo(-60, 60))).toEqual({
      tickLower: -60,
      tickUpper: 60,
    });
  });

  it('ignores the subscriber byte and the packed pool id', () => {
    const info = packInfo(223080, 223740) | 0xffn | (123n << 56n);

    expect(decodePositionTicks(info)).toEqual({
      tickLower: 223080,
      tickUpper: 223740,
    });
  });
});

describe('discover', () => {
  const live: FakePosition = {
    owner: OWNER,
    liquidity: 60_210_398_382_745n,
    poolKey: POOL,
    info: packInfo(223080, 223740),
  };

  it('returns positions the wallet holds in the configured pool', async () => {
    const {reader} = harness({'422596': live}, [422596n]);

    const found = await reader.discover(POOL, OWNER);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      tokenId: 422596n,
      tickLower: 223080,
      tickUpper: 223740,
    });
  });

  it('ignores positions in a different pool', async () => {
    const {reader} = harness({'99': {...live, poolKey: OTHER_POOL}}, [99n]);

    expect(await reader.discover(POOL, OWNER)).toEqual([]);
  });

  it('ignores positions the wallet no longer owns', async () => {
    const {reader} = harness({'99': {...live, owner: STRANGER}}, [99n]);

    expect(await reader.discover(POOL, OWNER)).toEqual([]);
  });

  it('ignores positions with no liquidity left', async () => {
    const {reader} = harness({'99': {...live, liquidity: 0n}}, [99n]);

    expect(await reader.discover(POOL, OWNER)).toEqual([]);
  });

  it('ignores a token that has since been burned', async () => {
    const {reader} = harness({}, [99n]);

    expect(await reader.discover(POOL, OWNER)).toEqual([]);
  });

  it('separates the wallet own positions from unrelated ones', async () => {
    const {reader} = harness(
      {
        '1': live,
        '2': {...live, poolKey: OTHER_POOL},
        '3': {...live, owner: STRANGER},
        '4': {...live, liquidity: 0n},
      },
      [1n, 2n, 3n, 4n],
    );

    const found = await reader.discover(POOL, OWNER);

    expect(found.map(p => p.tokenId)).toEqual([1n]);
  });

  it('survives an RPC that rejects a log range', async () => {
    const {reader, client} = harness({'422596': live}, [422596n]);
    client.getLogs.mockRejectedValueOnce(new Error('range too large'));

    await expect(reader.discover(POOL, OWNER)).resolves.toBeDefined();
  });
});

describe('read', () => {
  it('returns undefined for a position in another pool', async () => {
    const {reader} = harness(
      {
        '7': {
          owner: OWNER,
          liquidity: 1n,
          poolKey: OTHER_POOL,
          info: packInfo(0, 60),
        },
      },
      [],
    );

    expect(await reader.read(7n, POOL, OWNER)).toBeUndefined();
  });

  it('returns the position when everything matches', async () => {
    const {reader} = harness(
      {
        '7': {
          owner: OWNER,
          liquidity: 5n,
          poolKey: POOL,
          info: packInfo(120, 180),
        },
      },
      [],
    );

    expect(await reader.read(7n, POOL, OWNER)).toEqual({
      tokenId: 7n,
      tickLower: 120,
      tickUpper: 180,
      liquidity: 5n,
    });
  });
});
