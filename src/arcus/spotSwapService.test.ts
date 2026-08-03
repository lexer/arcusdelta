import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {
  ArcusFirmQuote,
  StatusResponse,
  TokenInfo,
} from '@arcus-xyz/arcus-spot-sdk';
import {pino} from 'pino';
import type {WalletProvider} from '../chain/walletProvider.js';
import {
  ArcusExecutionFailedError,
  ArcusPermitError,
  ArcusPollTimeoutError,
  ArcusPriceImpactError,
  ArcusQuoteError,
  ArcusSubmissionError,
  ArcusTwapConfigError,
  ArcusTwapPartialFillError,
  QuoteValidationError,
} from './errors.js';
import {SpotSwapService, type SpotRouter} from './spotSwapService.js';
import {TokenResolver} from './tokenResolver.js';

const {signQuoteMock, buildPermitMock} = vi.hoisted(() => ({
  signQuoteMock: vi.fn(),
  buildPermitMock: vi.fn(),
}));

vi.mock('@arcus-xyz/arcus-spot-sdk', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@arcus-xyz/arcus-spot-sdk')>();
  return {
    ...actual,
    signQuote: signQuoteMock,
    buildArcusSellTokenPermitIfNeeded: buildPermitMock,
  };
});

const {PermitUnsupportedError} = await import('@arcus-xyz/arcus-spot-sdk');

const TAKER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const ORDER_ID = `0x${'cd'.repeat(32)}` as const;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const USDG: TokenInfo = {
  chainId: 4663,
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  name: 'Global Dollar',
  decimals: 6,
  source: 'server',
  category: 'crypto',
  verified: true,
};

const NVDA: TokenInfo = {
  chainId: 4663,
  address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  symbol: 'NVDA',
  name: 'NVIDIA',
  decimals: 18,
  source: 'server',
  category: 'stock',
  verified: true,
};

/** 100 USDG at 6 decimals. */
const SELL_ATOMS = '100000000';

function makeQuote(overrides: Partial<ArcusFirmQuote> = {}): ArcusFirmQuote {
  return {
    venue: 'arcus',
    sellAmount: SELL_ATOMS,
    buyAmount: '500000000000000000',
    fees: [],
    expiry: Math.floor(Date.now() / 1000) + 60,
    toSign: {} as ArcusFirmQuote['toSign'],
    arcus: {minAmountOut: '499000000000000000'},
    ...overrides,
  };
}

interface PublicClientMock {
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
}

function makePublicClient(): PublicClientMock {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(1_000n),
    // No reconciliation match by default: existing failure paths still throw.
    getLogs: vi.fn().mockResolvedValue([]),
  };
}

function makeWallet(publicClient: PublicClientMock): WalletProvider {
  return {
    getAccount: () => ({address: TAKER}) as never,
    getWalletClient: () => ({}) as never,
    getPublicClient: () => publicClient as never,
  };
}

interface Harness {
  service: SpotSwapService;
  router: {
    getQuote: ReturnType<typeof vi.fn>;
    submitSignedQuote: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
  };
  sleep: ReturnType<typeof vi.fn>;
  publicClient: PublicClientMock;
}

function harness(
  statuses: StatusResponse['status'][] = ['confirmed'],
  publicClient: PublicClientMock = makePublicClient(),
): Harness {
  const getStatus = vi.fn();
  for (const status of statuses) {
    getStatus.mockResolvedValueOnce({venue: 'arcus', status, raw: {}});
  }
  getStatus.mockResolvedValue({venue: 'arcus', status: 'pending', raw: {}});

  const router = {
    getQuote: vi
      .fn()
      .mockResolvedValue({recommended: 'arcus', all: [makeQuote()]}),
    submitSignedQuote: vi.fn().mockResolvedValue({
      venue: 'arcus',
      txHash: TX_HASH,
      status: 'submitted',
      orderId: ORDER_ID,
    }),
    getStatus,
  };
  const sleep = vi.fn().mockResolvedValue(undefined);

  const service = new SpotSwapService({
    router: router as SpotRouter,
    wallet: makeWallet(publicClient),
    tokens: new TokenResolver(
      {getTokenList: () => Promise.resolve([USDG, NVDA])},
      4663,
    ),
    logger: pino({level: 'silent'}),
    chainId: 4663,
    sellSymbol: 'USDG',
    sleep,
  });

  return {service, router, sleep, publicClient};
}

const request = {
  tradeId: 'trade-1',
  buyToken: NVDA.address,
  sellAmount: '100',
  slippageBps: 1,
};

beforeEach(() => {
  signQuoteMock.mockResolvedValue({venue: 'arcus'});
  buildPermitMock.mockResolvedValue(undefined);
});

describe('executeBuy happy path', () => {
  it('quotes, signs, submits, and confirms', async () => {
    const {service, router} = harness();

    const result = await service.executeBuy(request);

    expect(result).toMatchObject({
      tradeId: 'trade-1',
      txHashes: [TX_HASH],
      orderId: ORDER_ID,
      sellAmount: SELL_ATOMS,
      minBuyAmount: '499000000000000000',
    });
    expect(router.getQuote).toHaveBeenCalledWith({
      chainId: 4663,
      sellToken: USDG.address,
      buyToken: NVDA.address,
      sellAmount: SELL_ATOMS,
      taker: TAKER,
      slippageBps: 1,
    });
  });

  it('folds a permit into the signature when one is required', async () => {
    const permit = {
      token: USDG.address,
      value: '1',
      deadline: '2',
      v: 27,
      r: '0x',
      s: '0x',
    };
    buildPermitMock.mockResolvedValue(permit);
    const {service} = harness();

    await service.executeBuy(request);

    expect(signQuoteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        permits: [permit],
      },
    );
  });

  it('polls until the trade leaves the pending state', async () => {
    const {service, router} = harness(['pending', 'submitted', 'confirmed']);

    await service.executeBuy(request);

    expect(router.getStatus).toHaveBeenCalledTimes(3);
  });
});

describe('executeSell', () => {
  /** 0.5 NVDA at 18 decimals, matching the quote fixture below. */
  const SELL_STOCK_ATOMS = 500_000_000_000_000_000n;

  function sellHarness() {
    const h = harness();
    h.router.getQuote.mockResolvedValue({
      recommended: 'arcus',
      all: [
        makeQuote({
          sellAmount: SELL_STOCK_ATOMS.toString(),
          buyAmount: '99000000',
          arcus: {minAmountOut: '98000000'},
        }),
      ],
    });
    return h;
  }

  const sellRequest = {
    tradeId: 'sell-1',
    sellToken: NVDA.address,
    sellAmountAtoms: SELL_STOCK_ATOMS,
    slippageBps: 1,
  };

  it('quotes the stock token into USDG, not the reverse', async () => {
    const {service, router} = sellHarness();

    await service.executeSell(sellRequest);

    expect(router.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        sellToken: NVDA.address,
        buyToken: USDG.address,
        sellAmount: SELL_STOCK_ATOMS.toString(),
      }),
    );
  });

  it('spends the exact balance it was given', async () => {
    const {service} = sellHarness();

    const result = await service.executeSell(sellRequest);

    expect(result.sellAmount).toBe(SELL_STOCK_ATOMS.toString());
    expect(result.txHashes).toEqual([TX_HASH]);
  });

  it('runs the same permit and sign path as a buy', async () => {
    const {service} = sellHarness();

    await service.executeSell(sellRequest);

    expect(buildPermitMock).toHaveBeenCalled();
    expect(signQuoteMock).toHaveBeenCalled();
  });

  it('rejects a quote that would spend a different amount', async () => {
    const {service, router} = sellHarness();
    router.getQuote.mockResolvedValue({
      recommended: 'arcus',
      all: [makeQuote({sellAmount: '1'})],
    });

    await expect(service.executeSell(sellRequest)).rejects.toThrow(
      QuoteValidationError,
    );
    expect(signQuoteMock).not.toHaveBeenCalled();
  });

  it('surfaces a missing arcus quote', async () => {
    const {service, router} = sellHarness();
    router.getQuote.mockResolvedValue({recommended: 'lifi', all: []});

    await expect(service.executeSell(sellRequest)).rejects.toThrow(
      ArcusQuoteError,
    );
  });

  it('never checks price impact — SellRequest has no threshold to check against', async () => {
    const {service, router} = sellHarness();

    await service.executeSell(sellRequest);

    // One quote for the trade itself; no second reference quote requested.
    expect(router.getQuote).toHaveBeenCalledOnce();
  });
});

describe('previewQuote', () => {
  it('reports the trade in human units without signing', async () => {
    const {service, router} = harness();

    const preview = await service.previewQuote(request);

    expect(preview).toMatchObject({
      venue: 'arcus',
      sellSymbol: 'USDG',
      sellAmount: '100',
      buySymbol: 'NVDA',
      buyAmount: '0.5',
      minBuyAmount: '0.499',
      pricePerUnit: '200.0000',
    });
    expect(signQuoteMock).not.toHaveBeenCalled();
    expect(router.submitSignedQuote).not.toHaveBeenCalled();
    expect(router.getStatus).not.toHaveBeenCalled();
  });

  it('applies the same validation a buy would', async () => {
    const {service, router} = harness();
    router.getQuote.mockResolvedValue({
      recommended: 'arcus',
      all: [makeQuote({sellAmount: '999999999'})],
    });

    await expect(service.previewQuote(request)).rejects.toThrow(
      QuoteValidationError,
    );
  });
});

describe('executeBuy failures before signing', () => {
  it('rejects when the router returns no arcus quote', async () => {
    const {service, router} = harness();
    router.getQuote.mockResolvedValue({
      recommended: 'lifi',
      all: [],
      errors: [{venue: 'arcus', error: {kind: 'http_5xx', message: 'boom'}}],
    });

    await expect(service.executeBuy(request)).rejects.toThrow(ArcusQuoteError);
    expect(signQuoteMock).not.toHaveBeenCalled();
    expect(router.submitSignedQuote).not.toHaveBeenCalled();
  });

  it('rejects a quote that spends a different amount than requested', async () => {
    const {service, router} = harness();
    router.getQuote.mockResolvedValue({
      recommended: 'arcus',
      all: [makeQuote({sellAmount: '999999999'})],
    });

    await expect(service.executeBuy(request)).rejects.toThrow(
      QuoteValidationError,
    );
    expect(signQuoteMock).not.toHaveBeenCalled();
  });

  it('rejects a quote with no guaranteed output', async () => {
    const {service, router} = harness();
    router.getQuote.mockResolvedValue({
      recommended: 'arcus',
      all: [makeQuote({arcus: {minAmountOut: '0'}})],
    });

    await expect(service.executeBuy(request)).rejects.toThrow(
      QuoteValidationError,
    );
    expect(signQuoteMock).not.toHaveBeenCalled();
  });

  it('rejects an already-expired quote', async () => {
    const {service, router} = harness();
    router.getQuote.mockResolvedValue({
      recommended: 'arcus',
      all: [makeQuote({expiry: Math.floor(Date.now() / 1000) - 1})],
    });

    await expect(service.executeBuy(request)).rejects.toThrow(
      QuoteValidationError,
    );
    expect(signQuoteMock).not.toHaveBeenCalled();
  });

  it('surfaces a non-permittable sell token without signing', async () => {
    buildPermitMock.mockRejectedValue(
      new PermitUnsupportedError(USDG.address, PERMIT2, 100n, 0n),
    );
    const {service, router} = harness();

    await expect(service.executeBuy(request)).rejects.toThrow(ArcusPermitError);
    expect(signQuoteMock).not.toHaveBeenCalled();
    expect(router.submitSignedQuote).not.toHaveBeenCalled();
  });
});

describe('executeBuy failures after signing', () => {
  it('wraps a router submission rejection', async () => {
    const {service, router} = harness();
    router.submitSignedQuote.mockRejectedValue(new Error('nonce reuse'));

    await expect(service.executeBuy(request)).rejects.toThrow(
      ArcusSubmissionError,
    );
  });

  it('reports a trade that settles as failed', async () => {
    const {service} = harness(['failed']);

    await expect(service.executeBuy(request)).rejects.toThrow(
      ArcusExecutionFailedError,
    );
  });

  it('gives up after the poll budget instead of looping forever', async () => {
    const {service, router} = harness([]);

    await expect(service.executeBuy(request)).rejects.toThrow(
      ArcusPollTimeoutError,
    );
    // 60s budget at a 2s interval.
    expect(router.getStatus).toHaveBeenCalledTimes(30);
  });
});

describe('reconciliation after a submission failure', () => {
  const RECONCILED_TX = `0x${'ef'.repeat(32)}` as const;
  const ROUTER = '0x0000000000000000000000000000000000dEaD';

  it('reports a real result when the trade actually settled on chain', async () => {
    const publicClient = makePublicClient();
    publicClient.getLogs
      .mockResolvedValueOnce([
        {
          args: {from: TAKER, to: ROUTER, value: BigInt(SELL_ATOMS)},
          transactionHash: RECONCILED_TX,
          blockNumber: 1_005n,
        },
      ])
      .mockResolvedValueOnce([
        {
          args: {from: ROUTER, to: TAKER, value: 495_000_000_000_000_000n},
          transactionHash: RECONCILED_TX,
          blockNumber: 1_005n,
        },
      ]);
    const {service, router} = harness(['confirmed'], publicClient);
    router.submitSignedQuote.mockRejectedValue(new Error('502 Bad Gateway'));

    const result = await service.executeBuy(request);

    expect(result).toMatchObject({
      txHashes: [RECONCILED_TX],
      orderId: undefined,
      buyAmount: '495000000000000000',
    });
    expect(publicClient.getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({address: USDG.address}),
    );
    expect(publicClient.getLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({address: NVDA.address}),
    );
  });

  it('falls back to the quoted amount when no matching buy-token transfer is found', async () => {
    const publicClient = makePublicClient();
    publicClient.getLogs
      .mockResolvedValueOnce([
        {
          args: {from: TAKER, to: ROUTER, value: BigInt(SELL_ATOMS)},
          transactionHash: RECONCILED_TX,
          blockNumber: 1_005n,
        },
      ])
      .mockResolvedValueOnce([]);
    const {service, router} = harness(['confirmed'], publicClient);
    router.submitSignedQuote.mockRejectedValue(new Error('502 Bad Gateway'));

    const result = await service.executeBuy(request);

    expect(result.txHashes).toEqual([RECONCILED_TX]);
    // The quote fixture's buyAmount — nothing on chain confirms the real one.
    expect(result.buyAmount).toBe('500000000000000000');
  });

  it('still throws when no on-chain transfer matches the exact amount', async () => {
    const publicClient = makePublicClient();
    publicClient.getLogs.mockResolvedValueOnce([
      {
        args: {from: TAKER, to: ROUTER, value: 1n},
        transactionHash: TX_HASH,
        blockNumber: 1_005n,
      },
    ]);
    const {service, router} = harness(['confirmed'], publicClient);
    router.submitSignedQuote.mockRejectedValue(new Error('502 Bad Gateway'));

    await expect(service.executeBuy(request)).rejects.toThrow(
      ArcusSubmissionError,
    );
  });
});

describe('TWAP chunking', () => {
  /** Echoes back a quote for whatever sellAmount was actually requested, at a fixed 5:1 rate. */
  function twapQuoteRouter(router: Harness['router']) {
    router.getQuote.mockImplementation(req =>
      Promise.resolve({
        recommended: 'arcus',
        all: [
          makeQuote({
            sellAmount: req.sellAmount,
            buyAmount: (BigInt(req.sellAmount) * 5n).toString(),
            arcus: {minAmountOut: (BigInt(req.sellAmount) * 4n).toString()},
          }),
        ],
      }),
    );
  }

  const CHUNK_TX = [
    `0x${'11'.repeat(32)}`,
    `0x${'22'.repeat(32)}`,
    `0x${'33'.repeat(32)}`,
  ] as const;

  it('splits into the requested chunk count, remainder in the last one, sleeping between but not after', async () => {
    const {service, router, sleep} = harness(
      ['confirmed', 'confirmed', 'confirmed'],
      makePublicClient(),
    );
    twapQuoteRouter(router);
    router.submitSignedQuote
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: CHUNK_TX[0],
        status: 'submitted',
        orderId: ORDER_ID,
      })
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: CHUNK_TX[1],
        status: 'submitted',
        orderId: ORDER_ID,
      })
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: CHUNK_TX[2],
        status: 'submitted',
        orderId: ORDER_ID,
      });

    const result = await service.executeBuy({
      ...request,
      twapChunks: 3,
      twapIntervalSeconds: 5,
    });

    const requestedAmounts = router.getQuote.mock.calls.map(
      call => call[0].sellAmount,
    );
    expect(requestedAmounts).toEqual(['33333333', '33333333', '33333334']);
    expect(requestedAmounts.reduce((sum, a) => sum + BigInt(a), 0n)).toBe(
      BigInt(SELL_ATOMS),
    );

    expect(result.txHashes).toEqual(CHUNK_TX);
    expect(result.orderId).toBeUndefined();
    expect(result.sellAmount).toBe(SELL_ATOMS);
    expect(result.buyAmount).toBe((BigInt(SELL_ATOMS) * 5n).toString());
    expect(result.minBuyAmount).toBe((BigInt(SELL_ATOMS) * 4n).toString());

    // Between chunks 1-2 and 2-3, never after the last.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('behaves identically to an un-chunked trade when twapChunks is 1', async () => {
    const {service, router} = harness();

    const result = await service.executeBuy({...request, twapChunks: 1});

    expect(router.getQuote).toHaveBeenCalledOnce();
    expect(result.txHashes).toEqual([TX_HASH]);
  });

  it('throws a partial-fill error carrying exactly what settled when a later chunk fails', async () => {
    const {service, router, sleep} = harness(
      ['confirmed', 'confirmed'],
      makePublicClient(),
    );
    twapQuoteRouter(router);
    router.submitSignedQuote
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: CHUNK_TX[0],
        status: 'submitted',
        orderId: ORDER_ID,
      })
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: CHUNK_TX[1],
        status: 'submitted',
        orderId: ORDER_ID,
      })
      .mockRejectedValueOnce(new Error('router unavailable'));

    const failure = await service
      .executeBuy({...request, twapChunks: 3, twapIntervalSeconds: 5})
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArcusTwapPartialFillError);
    const error = failure as ArcusTwapPartialFillError;
    expect(error.failedChunk).toBe(3);
    expect(error.totalChunks).toBe(3);
    expect(error.completedChunks).toHaveLength(2);
    expect(error.completedChunks.map(c => c.txHash)).toEqual([
      CHUNK_TX[0],
      CHUNK_TX[1],
    ]);
    // Slept after chunk 1 and chunk 2; the failed chunk 3 has nothing after it to wait for.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rejects a chunk count that would leave a chunk at zero atoms, before any quote is requested', async () => {
    const {service, router} = harness();

    await expect(
      service.executeBuy({
        ...request,
        sellAmount: '0.000001',
        twapChunks: 5,
      }),
    ).rejects.toThrow(ArcusTwapConfigError);
    expect(router.getQuote).not.toHaveBeenCalled();
  });

  it('chunks a sell the same way as a buy', async () => {
    const {service, router} = harness(['confirmed', 'confirmed']);
    twapQuoteRouter(router);
    router.submitSignedQuote
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: CHUNK_TX[0],
        status: 'submitted',
        orderId: ORDER_ID,
      })
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: CHUNK_TX[1],
        status: 'submitted',
        orderId: ORDER_ID,
      });

    const result = await service.executeSell({
      tradeId: 'sell-twap',
      sellToken: NVDA.address,
      sellAmountAtoms: 500_000_000_000_000_000n,
      slippageBps: 1,
      twapChunks: 2,
      twapIntervalSeconds: 5,
    });

    expect(result.txHashes).toEqual([CHUNK_TX[0], CHUNK_TX[1]]);
    const requestedAmounts = router.getQuote.mock.calls.map(
      call => call[0].sellAmount,
    );
    expect(requestedAmounts.reduce((sum, a) => sum + BigInt(a), 0n)).toBe(
      500_000_000_000_000_000n,
    );
  });
});

describe('price impact gate', () => {
  // 1% of SELL_ATOMS ('100000000'), matching SpotSwapService's own
  // reference-amount calculation.
  const REFERENCE_ATOMS = '1000000';

  /** buyAmount atoms such that the resulting quote prices at `price` USDG per NVDA. */
  function buyAtomsForPrice(sellAtoms: string, price: number): string {
    return BigInt(Math.round((Number(sellAtoms) * 1e12) / price)).toString();
  }

  /** Prices the reference-sized quote at `referencePrice`, everything else at `tradePrice`. */
  function priceImpactRouter(
    router: Harness['router'],
    referencePrice: number,
    tradePrice: number,
  ) {
    router.getQuote.mockImplementation(req => {
      const price =
        req.sellAmount === REFERENCE_ATOMS ? referencePrice : tradePrice;
      const buyAmount = buyAtomsForPrice(req.sellAmount, price);
      return Promise.resolve({
        recommended: 'arcus',
        all: [
          makeQuote({
            sellAmount: req.sellAmount,
            buyAmount,
            arcus: {minAmountOut: buyAmount},
          }),
        ],
      });
    });
  }

  it('executes normally when price impact is within the threshold', async () => {
    const {service, router} = harness();
    priceImpactRouter(router, 200, 200.1); // ~5 bps, under the 100 bps threshold

    const result = await service.executeBuy({
      ...request,
      maxPriceImpactBps: 100,
    });

    expect(router.getQuote).toHaveBeenCalledTimes(2);
    expect(router.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({sellAmount: REFERENCE_ATOMS}),
    );
    expect(result.txHashes).toEqual([TX_HASH]);
  });

  it('refuses an un-chunked buy whose price impact exceeds the threshold', async () => {
    const {service, router} = harness();
    priceImpactRouter(router, 200, 204); // 2% = 200 bps, over the 100 bps threshold

    const failure = await service
      .executeBuy({...request, maxPriceImpactBps: 100})
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArcusPriceImpactError);
    const error = failure as ArcusPriceImpactError;
    expect(error.maxPriceImpactBps).toBe(100);
    expect(error.priceImpactBps).toBeGreaterThan(100);
    expect(signQuoteMock).not.toHaveBeenCalled();
  });

  it('checks impact before every TWAP chunk, wrapping a mid-sequence breach in the existing partial-fill error', async () => {
    const {service, router, sleep} = harness(
      ['confirmed', 'confirmed'],
      makePublicClient(),
    );
    // Chunks 1 and 2 trade at the reference price (no impact); chunk 3 does not.
    let tradeCalls = 0;
    router.getQuote.mockImplementation(req => {
      let price: number;
      if (req.sellAmount === '333333') {
        price = 200; // every chunk's reference call
      } else {
        tradeCalls++;
        price = tradeCalls <= 2 ? 200 : 400; // chunk 3 is 100% worse
      }
      const buyAmount = buyAtomsForPrice(req.sellAmount, price);
      return Promise.resolve({
        recommended: 'arcus',
        all: [
          makeQuote({
            sellAmount: req.sellAmount,
            buyAmount,
            arcus: {minAmountOut: buyAmount},
          }),
        ],
      });
    });
    router.submitSignedQuote
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: `0x${'11'.repeat(32)}`,
        status: 'submitted',
        orderId: ORDER_ID,
      })
      .mockResolvedValueOnce({
        venue: 'arcus',
        txHash: `0x${'22'.repeat(32)}`,
        status: 'submitted',
        orderId: ORDER_ID,
      });

    const failure = await service
      .executeBuy({
        ...request,
        twapChunks: 3,
        twapIntervalSeconds: 5,
        maxPriceImpactBps: 100,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArcusTwapPartialFillError);
    const error = failure as ArcusTwapPartialFillError;
    expect(error.failedChunk).toBe(3);
    expect(error.totalChunks).toBe(3);
    expect(error.completedChunks).toHaveLength(2);
    // Chunk 3's submission is never reached — the breach is caught first.
    expect(router.submitSignedQuote).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
