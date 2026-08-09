/**
 * Executes a spot buy on the Arcus venue: quote, validate, permit, sign,
 * submit, then poll to a terminal state.
 *
 * Only the read-only status poll retries. Nothing in the quote -> sign ->
 * submit chain is retried automatically, so a failure never risks funds twice.
 */

import {
  PermitUnsupportedError,
  buildArcusSellTokenPermitIfNeeded,
  signQuote,
  type ArcusFirmQuote,
  type Permit,
  type QuoteRequest,
  type QuoteResponse,
  type SignedQuote,
  type StatusRequest,
  type StatusResponse,
  type SubmitResponse,
  type TokenInfo,
} from '@arcus-xyz/arcus-spot-sdk';
import {formatUnits, parseAbiItem, parseUnits, type Hex} from 'viem';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Logger} from '../logging/logger.js';
import {
  ArcusExecutionFailedError,
  ArcusPollTimeoutError,
  ArcusPriceFeedError,
  ArcusPriceImpactError,
  ArcusQuoteError,
  ArcusSubmissionError,
  ArcusPermitError,
  ArcusTwapConfigError,
  ArcusTwapPartialFillError,
  QuoteValidationError,
} from './errors.js';
import type {TokenResolver} from './tokenResolver.js';
import type {
  BuyRequest,
  BuyResult,
  QuotePreview,
  SellRequest,
} from './types.js';
import type {PriceFeed, TokenPrice} from '../prices/priceFeed.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/**
 * Human-readable unit price. Display only — float division, never used to size
 * a trade or bound slippage, both of which stay in integer atoms.
 */
function divideForDisplay(numerator: string, denominator: string): string {
  const value = Number(numerator) / Number(denominator);
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(4);
}

/**
 * Splits `total` into `chunks` pieces, every one but the last getting
 * `floor(total / chunks)` and the last taking the remainder — so the sum is
 * always exactly `total`, with no dust lost to rounding.
 */
function splitIntoChunks(total: bigint, chunks: number): bigint[] {
  const base = total / BigInt(chunks);
  const amounts = new Array<bigint>(chunks - 1).fill(base);
  amounts.push(total - base * BigInt(chunks - 1));
  return amounts;
}

/** Sums atomic-unit decimal strings without going through floating point. */
function sumAtoms(amounts: readonly string[]): string {
  return amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString();
}

/**
 * Sell units per buy unit, decimal-normalized. Display/comparison only —
 * never used to size a trade or bound slippage, both of which stay in atoms.
 */
function effectivePrice(
  quote: {sellAmount: string; buyAmount: string},
  sellDecimals: number,
  buyDecimals: number,
): number {
  const sell = Number(quote.sellAmount) / 10 ** sellDecimals;
  const buy = Number(quote.buyAmount) / 10 ** buyDecimals;
  return sell / buy;
}

/** One chunk's settled trade — the same shape a single, un-chunked trade returns. */
interface SingleTradeResult {
  readonly txHash: Hex;
  readonly orderId: Hex | undefined;
  readonly sellAmount: string;
  readonly buyAmount: string;
  readonly minBuyAmount: string;
}

/** The subset of SpotRouterClient this service depends on. */
export interface SpotRouter {
  getQuote(request: QuoteRequest): Promise<QuoteResponse>;
  submitSignedQuote(signed: SignedQuote): Promise<SubmitResponse>;
  getStatus(request: StatusRequest): Promise<StatusResponse>;
}

/** Injected so tests can drive the poll loop without real timers. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface SpotSwapServiceOptions {
  readonly router: SpotRouter;
  readonly wallet: WalletProvider;
  readonly tokens: TokenResolver;
  readonly logger: Logger;
  readonly chainId: number;
  /** Symbol of the token spent on every buy. */
  readonly sellSymbol: string;
  /** The true-market reference the price impact gate compares a buy against. */
  readonly priceFeed: PriceFeed;
  readonly sleep?: Sleep;
}

export class SpotSwapService {
  private readonly router: SpotRouter;
  private readonly wallet: WalletProvider;
  private readonly tokens: TokenResolver;
  private readonly logger: Logger;
  private readonly chainId: number;
  private readonly sellSymbol: string;
  private readonly priceFeed: PriceFeed;
  private readonly sleep: Sleep;

  constructor(options: SpotSwapServiceOptions) {
    this.router = options.router;
    this.wallet = options.wallet;
    this.tokens = options.tokens;
    this.logger = options.logger;
    this.chainId = options.chainId;
    this.sellSymbol = options.sellSymbol;
    this.priceFeed = options.priceFeed;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Read-only preflight: resolves tokens, quotes, and validates, exactly as
   * {@link executeBuy} does, then stops. Nothing is signed or submitted.
   */
  async previewQuote(request: BuyRequest): Promise<QuotePreview> {
    const log = this.logger.child({tradeId: request.tradeId});
    log.info(
      {
        buyToken: request.buyToken,
        sellAmount: request.sellAmount,
        slippageBps: request.slippageBps,
      },
      'quote preview started',
    );

    const {quote, sellToken, buyToken} = await this.prepare(request, log);
    const buyAmount = formatUnits(BigInt(quote.buyAmount), buyToken.decimals);
    const minBuyAmount = formatUnits(
      BigInt(quote.arcus.minAmountOut),
      buyToken.decimals,
    );

    return {
      tradeId: request.tradeId,
      venue: 'arcus',
      sellSymbol: sellToken.symbol,
      sellAmount: request.sellAmount,
      buySymbol: buyToken.symbol,
      buyAmount,
      minBuyAmount,
      pricePerUnit: divideForDisplay(request.sellAmount, buyAmount),
      expiresAt: new Date(quote.expiry * 1000).toISOString(),
      fees: quote.fees,
    };
  }

  /**
   * Read-only preview of the *sell* direction: what an exact amount of a
   * token would fetch in the quote currency right now.
   *
   * The mirror of {@link previewQuote}, and the exit valuation the pair
   * monitor needs — proceeds from a real quote for the real size, so spread
   * and price impact are already priced in rather than assumed away.
   */
  async previewSell(request: SellRequest): Promise<QuotePreview> {
    const log = this.logger.child({tradeId: request.tradeId});
    const sellToken = await this.tokens.byAddress(request.sellToken);
    const buyToken = await this.tokens.bySymbol(this.sellSymbol);

    const quote = await this.quoteAndValidate(
      request.tradeId,
      sellToken,
      buyToken,
      request.sellAmountAtoms.toString(),
      request.slippageBps,
      log,
    );

    const sellAmount = formatUnits(request.sellAmountAtoms, sellToken.decimals);
    const buyAmount = formatUnits(BigInt(quote.buyAmount), buyToken.decimals);
    return {
      tradeId: request.tradeId,
      venue: 'arcus',
      sellSymbol: sellToken.symbol,
      sellAmount,
      buySymbol: buyToken.symbol,
      buyAmount,
      minBuyAmount: formatUnits(
        BigInt(quote.arcus.minAmountOut),
        buyToken.decimals,
      ),
      pricePerUnit: divideForDisplay(buyAmount, sellAmount),
      expiresAt: new Date(quote.expiry * 1000).toISOString(),
      fees: quote.fees,
    };
  }

  async executeBuy(request: BuyRequest): Promise<BuyResult> {
    const log = this.logger.child({tradeId: request.tradeId});
    const startedAt = Date.now();
    const chunks = request.twapChunks ?? 1;
    log.info(
      {
        buyToken: request.buyToken,
        sellAmount: request.sellAmount,
        slippageBps: request.slippageBps,
        twapChunks: chunks,
      },
      'buy started',
    );

    const {sellToken, buyToken} = await this.resolveTokens(request.buyToken);
    const sellAmountAtoms = parseUnits(request.sellAmount, sellToken.decimals);
    log.info(
      {
        sellToken: sellToken.address,
        sellDecimals: sellToken.decimals,
        buyToken: buyToken.address,
        buySymbol: buyToken.symbol,
        sellAmountAtoms: sellAmountAtoms.toString(),
      },
      'tokens resolved',
    );

    const result = await this.executeWithTwap(
      request.tradeId,
      sellToken,
      buyToken,
      sellAmountAtoms,
      request.slippageBps,
      chunks,
      request.twapIntervalSeconds ?? 0,
      request.maxPriceImpactBps,
      log,
    );

    log.info({...result, elapsedMs: Date.now() - startedAt}, 'buy completed');
    return result;
  }

  /**
   * Sells an exact atom amount of `sellToken` back into the quote currency.
   *
   * Takes atoms rather than a decimal string because the caller is selling a
   * balance it read from chain, and that balance must be spent exactly.
   */
  async executeSell(request: SellRequest): Promise<BuyResult> {
    const log = this.logger.child({tradeId: request.tradeId});
    const startedAt = Date.now();
    const chunks = request.twapChunks ?? 1;
    log.info(
      {
        sellToken: request.sellToken,
        sellAmountAtoms: request.sellAmountAtoms.toString(),
        slippageBps: request.slippageBps,
        twapChunks: chunks,
      },
      'sell started',
    );

    const sellToken = await this.tokens.byAddress(request.sellToken);
    const buyToken = await this.tokens.bySymbol(this.sellSymbol);

    const result = await this.executeWithTwap(
      request.tradeId,
      sellToken,
      buyToken,
      request.sellAmountAtoms,
      request.slippageBps,
      chunks,
      request.twapIntervalSeconds ?? 0,
      // Price impact gating is buy-only; SellRequest has no such field.
      undefined,
      log,
    );

    log.info({...result, elapsedMs: Date.now() - startedAt}, 'sell completed');
    return result;
  }

  private async resolveTokens(
    buyTokenAddress: Hex,
  ): Promise<{sellToken: TokenInfo; buyToken: TokenInfo}> {
    const [sellToken, buyToken] = await Promise.all([
      this.tokens.bySymbol(this.sellSymbol),
      this.tokens.byAddress(buyTokenAddress),
    ]);
    return {sellToken, buyToken};
  }

  /**
   * Quote, optionally gate on price impact, validate, and settle exactly one
   * trade of `sellAmountAtoms`.
   */
  private async executeSingle(
    tradeId: string,
    sellToken: TokenInfo,
    buyToken: TokenInfo,
    sellAmountAtoms: string,
    slippageBps: number,
    maxPriceImpactBps: number | undefined,
    log: Logger,
  ): Promise<SingleTradeResult> {
    const quote = await this.quoteAndValidate(
      tradeId,
      sellToken,
      buyToken,
      sellAmountAtoms,
      slippageBps,
      log,
    );

    if (maxPriceImpactBps !== undefined) {
      await this.checkPriceImpact(
        tradeId,
        sellToken,
        buyToken,
        quote,
        maxPriceImpactBps,
        log,
      );
    }

    return this.settle(
      quote,
      tradeId,
      sellToken.address,
      buyToken.address,
      log,
    );
  }

  /**
   * Refuses a trade whose price has moved more than the configured threshold
   * versus the Robinhood price feed's reference for the same asset — a true
   * exchange price, not derived from Arcus or any DEX, so this stays correct
   * regardless of how Arcus itself routes the trade. USDG is treated 1:1
   * with USD, same as everywhere else in this codebase.
   */
  private async checkPriceImpact(
    tradeId: string,
    sellToken: TokenInfo,
    buyToken: TokenInfo,
    quote: ArcusFirmQuote,
    maxPriceImpactBps: number,
    log: Logger,
  ): Promise<void> {
    let reference: TokenPrice;
    try {
      reference = await this.priceFeed.getPrice(this.chainId, buyToken.address);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({error: message}, 'price feed lookup failed');
      throw new ArcusPriceFeedError(
        `Could not verify price impact for ${buyToken.symbol}: ${message}`,
        tradeId,
      );
    }

    if (reference.isTradingHalt) {
      log.error(
        {symbol: buyToken.symbol},
        'reference exchange has halted trading',
      );
      throw new ArcusPriceFeedError(
        `${buyToken.symbol} is halted on the reference exchange; refusing to buy without a reliable price`,
        tradeId,
      );
    }

    const tradePrice = effectivePrice(
      quote,
      sellToken.decimals,
      buyToken.decimals,
    );
    // The ask is the side a buyer actually crosses, so a trade with no
    // size-driven impact reads as ~0 bps, not half the bid/ask spread.
    const referencePrice = reference.ask;
    const impactBps = ((tradePrice - referencePrice) / referencePrice) * 10_000;

    log.info(
      {tradePrice, referencePrice, impactBps, maxPriceImpactBps},
      'price impact checked',
    );

    if (impactBps > maxPriceImpactBps) {
      log.error(
        {impactBps, maxPriceImpactBps},
        'price impact exceeds threshold',
      );
      throw new ArcusPriceImpactError(
        `Price impact ${impactBps.toFixed(2)} bps exceeds the ${maxPriceImpactBps} bps threshold (Arcus ${tradePrice.toFixed(4)} vs Robinhood ask ${referencePrice.toFixed(4)})`,
        tradeId,
        impactBps,
        maxPriceImpactBps,
      );
    }
  }

  /**
   * `chunks <= 1` runs exactly the single-trade path that predates TWAP —
   * same logging, same errors, byte-for-byte. `chunks > 1` splits the total
   * into that many pieces (see {@link splitIntoChunks}), quoting and settling
   * each one in sequence with its own quote, `twapIntervalSeconds` apart. A
   * chunk failing after earlier ones already settled throws
   * {@link ArcusTwapPartialFillError} carrying exactly what filled — the
   * caller must never be left assuming nothing happened when it did.
   */
  private async executeWithTwap(
    tradeId: string,
    sellToken: TokenInfo,
    buyToken: TokenInfo,
    totalSellAmountAtoms: bigint,
    slippageBps: number,
    chunks: number,
    intervalSeconds: number,
    maxPriceImpactBps: number | undefined,
    log: Logger,
  ): Promise<BuyResult> {
    if (chunks <= 1) {
      const result = await this.executeSingle(
        tradeId,
        sellToken,
        buyToken,
        totalSellAmountAtoms.toString(),
        slippageBps,
        maxPriceImpactBps,
        log,
      );
      return {
        tradeId,
        txHashes: [result.txHash],
        orderId: result.orderId,
        sellAmount: result.sellAmount,
        buyAmount: result.buyAmount,
        minBuyAmount: result.minBuyAmount,
      };
    }

    const chunkAmounts = splitIntoChunks(totalSellAmountAtoms, chunks);
    if (chunkAmounts.some(amount => amount === 0n)) {
      throw new ArcusTwapConfigError(
        `twapChunks=${chunks} is too many for a trade of ${totalSellAmountAtoms} atoms of ${sellToken.symbol} — at least one chunk would be zero`,
        tradeId,
      );
    }

    const completed: SingleTradeResult[] = [];
    for (let i = 0; i < chunkAmounts.length; i++) {
      const chunkNumber = i + 1;
      const chunkTradeId = `${tradeId}-${chunkNumber}`;
      const chunkLog = log.child({twapChunk: chunkNumber, twapChunks: chunks});
      chunkLog.info(
        {sellAmountAtoms: chunkAmounts[i]!.toString()},
        'twap chunk started',
      );

      try {
        const result = await this.executeSingle(
          chunkTradeId,
          sellToken,
          buyToken,
          chunkAmounts[i]!.toString(),
          slippageBps,
          maxPriceImpactBps,
          chunkLog,
        );
        completed.push(result);
        chunkLog.info({...result}, 'twap chunk settled');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        chunkLog.error(
          {error: message, completedChunks: completed.length},
          'twap chunk failed',
        );
        throw new ArcusTwapPartialFillError(
          `TWAP chunk ${chunkNumber} of ${chunks} failed: ${message}`,
          tradeId,
          completed.map(chunk => ({
            txHash: chunk.txHash,
            sellAmount: chunk.sellAmount,
            buyAmount: chunk.buyAmount,
          })),
          chunkNumber,
          chunks,
        );
      }

      if (chunkNumber < chunks) await this.sleep(intervalSeconds * 1000);
    }

    return {
      tradeId,
      txHashes: completed.map(chunk => chunk.txHash),
      orderId: undefined,
      sellAmount: sumAtoms(completed.map(chunk => chunk.sellAmount)),
      buyAmount: sumAtoms(completed.map(chunk => chunk.buyAmount)),
      minBuyAmount: sumAtoms(completed.map(chunk => chunk.minBuyAmount)),
    };
  }

  /**
   * Permit, sign, submit, poll. Shared by both directions so a sell cannot
   * diverge from the buy path that has already run live.
   */
  private async settle(
    quote: ArcusFirmQuote,
    tradeId: string,
    sellToken: Hex,
    buyToken: Hex,
    log: Logger,
  ): Promise<SingleTradeResult> {
    const permit = await this.buildPermit(quote, tradeId, log);

    log.info('signing quote');
    const signed = await signQuote(quote, this.wallet.getWalletClient(), {
      ...(permit ? {permits: [permit]} : {}),
    });
    log.info('quote signed');

    // Captured before submitting so a reconciliation scan (below) covers
    // exactly this attempt, not any earlier trade.
    const fromBlock = await this.wallet.getPublicClient().getBlockNumber();

    let submission: SubmitResponse;
    try {
      submission = await this.submit(signed, tradeId, log);
    } catch (error) {
      const reconciled = await this.reconcileSettlement(
        sellToken,
        BigInt(quote.sellAmount),
        buyToken,
        quote.buyAmount,
        fromBlock,
        tradeId,
        log,
      );
      if (!reconciled) throw error;

      return {
        txHash: reconciled.txHash,
        orderId: undefined,
        sellAmount: quote.sellAmount,
        buyAmount: reconciled.buyAmount,
        minBuyAmount: quote.arcus.minAmountOut,
      };
    }

    const orderId =
      submission.venue === 'arcus' ? submission.orderId : undefined;

    await this.pollUntilTerminal(
      orderId ?? submission.txHash,
      submission.txHash,
      tradeId,
      log,
    );

    return {
      txHash: submission.txHash,
      orderId,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      minBuyAmount: quote.arcus.minAmountOut,
    };
  }

  /**
   * A submission-stage failure (e.g. a transport error) does not prove the
   * router never processed the swap — confirmed 2026-08-02, when a sell
   * settled on chain even though `submitSignedQuote` threw. Before letting a
   * false failure stand, check whether the exact sell landed anyway, scanning
   * only from the block captured just before this attempt so an unrelated
   * earlier trade of the same size cannot be mistaken for it.
   */
  private async reconcileSettlement(
    sellToken: Hex,
    sellAmountAtoms: bigint,
    buyToken: Hex,
    quotedBuyAmount: string,
    fromBlock: bigint,
    tradeId: string,
    log: Logger,
  ): Promise<{txHash: Hex; buyAmount: string} | undefined> {
    const client = this.wallet.getPublicClient();
    const owner = this.wallet.getAccount().address;

    const sellTransfers = await client.getLogs({
      address: sellToken,
      event: TRANSFER_EVENT,
      args: {from: owner},
      fromBlock,
      toBlock: 'latest',
    });
    const settled = sellTransfers.findLast(
      transfer => transfer.args.value === sellAmountAtoms,
    );
    if (!settled) return undefined;

    log.warn(
      {tradeId, txHash: settled.transactionHash},
      'submission reported failure, but a matching transfer was found on ' +
        'chain — reconciling instead of reporting a false failure',
    );

    const buyTransfersInBlock = await client.getLogs({
      address: buyToken,
      event: TRANSFER_EVENT,
      args: {to: owner},
      fromBlock: settled.blockNumber,
      toBlock: settled.blockNumber,
    });
    const buyTransfers = buyTransfersInBlock.filter(
      transfer => transfer.transactionHash === settled.transactionHash,
    );

    if (buyTransfers.length === 0) {
      log.warn(
        {tradeId, txHash: settled.transactionHash},
        'reconciled sell but found no matching buy-token transfer in the ' +
          'same transaction; reporting the quoted amount as an estimate',
      );
      return {txHash: settled.transactionHash, buyAmount: quotedBuyAmount};
    }

    const buyAmount = buyTransfers.reduce(
      (sum, transfer) => sum + (transfer.args.value ?? 0n),
      0n,
    );

    return {
      txHash: settled.transactionHash,
      buyAmount: buyAmount.toString(),
    };
  }

  /**
   * Everything a buy does before it commits: resolve tokens, quote, validate.
   * Shared with {@link previewQuote} so a preflight exercises the same path.
   */
  private async prepare(
    request: BuyRequest,
    log: Logger,
  ): Promise<{
    quote: ArcusFirmQuote;
    sellToken: TokenInfo;
    buyToken: TokenInfo;
  }> {
    const sellToken = await this.tokens.bySymbol(this.sellSymbol);
    const buyToken = await this.tokens.byAddress(request.buyToken);
    const sellAmountAtoms = parseUnits(
      request.sellAmount,
      sellToken.decimals,
    ).toString();
    log.info(
      {
        sellToken: sellToken.address,
        sellDecimals: sellToken.decimals,
        buyToken: buyToken.address,
        buySymbol: buyToken.symbol,
        sellAmountAtoms,
      },
      'tokens resolved',
    );

    const quote = await this.quoteAndValidate(
      request.tradeId,
      sellToken,
      buyToken,
      sellAmountAtoms,
      request.slippageBps,
      log,
    );

    return {quote, sellToken, buyToken};
  }

  /** Direction-agnostic: fetch a quote for a pair and gate it. */
  private async quoteAndValidate(
    tradeId: string,
    sellToken: TokenInfo,
    buyToken: TokenInfo,
    sellAmountAtoms: string,
    slippageBps: number,
    log: Logger,
  ): Promise<ArcusFirmQuote> {
    const quote = await this.fetchQuote(
      tradeId,
      sellToken,
      buyToken,
      sellAmountAtoms,
      slippageBps,
      log,
    );
    this.validateQuote(quote, tradeId, sellAmountAtoms, log);
    return quote;
  }

  private async fetchQuote(
    tradeId: string,
    sellToken: TokenInfo,
    buyToken: TokenInfo,
    sellAmountAtoms: string,
    slippageBps: number,
    log: Logger,
  ): Promise<ArcusFirmQuote> {
    log.info({venue: 'arcus'}, 'requesting quote');
    const response = await this.router.getQuote({
      chainId: this.chainId,
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      sellAmount: sellAmountAtoms,
      taker: this.wallet.getAccount().address,
      slippageBps,
    });

    const quote = response.all.find(
      (candidate): candidate is ArcusFirmQuote => candidate.venue === 'arcus',
    );
    if (!quote) {
      const venueErrors = (response.errors ?? []).map(
        entry => `${entry.venue}: ${entry.error.message}`,
      );
      log.error({venueErrors}, 'no arcus quote available');
      throw new ArcusQuoteError(
        'Arcus router returned no quote for this pair',
        tradeId,
        venueErrors,
      );
    }

    log.info(
      {
        buyAmount: quote.buyAmount,
        sellAmount: quote.sellAmount,
        minAmountOut: quote.arcus.minAmountOut,
        expiry: quote.expiry,
        fees: quote.fees,
      },
      'quote received',
    );
    return quote;
  }

  /** Last gate before a signature: a bad quote must never reach the wallet. */
  private validateQuote(
    quote: ArcusFirmQuote,
    tradeId: string,
    expectedSellAmount: string,
    log: Logger,
  ): void {
    if (quote.sellAmount !== expectedSellAmount) {
      log.error(
        {quoted: quote.sellAmount, expected: expectedSellAmount},
        'quote spends a different amount than requested',
      );
      throw new QuoteValidationError(
        `Quote sells ${quote.sellAmount} atoms but ${expectedSellAmount} was requested`,
        tradeId,
      );
    }

    if (BigInt(quote.arcus.minAmountOut) <= 0n) {
      throw new QuoteValidationError(
        'Quote guarantees no minimum output',
        tradeId,
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (quote.expiry <= nowSeconds) {
      throw new QuoteValidationError(
        `Quote expired at ${quote.expiry} (now ${nowSeconds})`,
        tradeId,
      );
    }

    log.info('quote validated');
  }

  private async buildPermit(
    quote: ArcusFirmQuote,
    tradeId: string,
    log: Logger,
  ): Promise<Permit | undefined> {
    try {
      const permit = await buildArcusSellTokenPermitIfNeeded({
        quote,
        publicClient: this.wallet.getPublicClient(),
        walletClient: this.wallet.getWalletClient(),
      });
      log.info({permitRequired: permit !== undefined}, 'permit checked');
      return permit;
    } catch (error) {
      if (!(error instanceof PermitUnsupportedError)) throw error;
      log.error(
        {
          token: error.token,
          spender: error.spender,
          currentAllowance: error.currentAllowance.toString(),
        },
        'sell token does not support EIP-2612 permit',
      );
      throw new ArcusPermitError(
        `Sell token ${error.token} cannot sign a permit. Send a one-time approve(${error.spender}) on it, then retry.`,
        tradeId,
        error.token,
        error.spender,
        error.currentAllowance,
      );
    }
  }

  private async submit(
    signed: SignedQuote,
    tradeId: string,
    log: Logger,
  ): Promise<SubmitResponse> {
    log.info('submitting signed quote');
    try {
      const response = await this.router.submitSignedQuote(signed);
      log.info(
        {
          txHash: response.txHash,
          orderId: response.venue === 'arcus' ? response.orderId : undefined,
        },
        'quote submitted',
      );
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({error: message}, 'submission rejected');
      throw new ArcusSubmissionError(
        `Arcus router rejected the signed quote: ${message}`,
        tradeId,
      );
    }
  }

  private async pollUntilTerminal(
    id: Hex,
    txHash: Hex,
    tradeId: string,
    log: Logger,
  ): Promise<void> {
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const status = await this.router.getStatus({
        venue: 'arcus',
        id,
        chainId: this.chainId,
      });
      const elapsedMs = Date.now() - startedAt;
      log.debug({attempt, elapsedMs, status: status.status}, 'status polled');

      if (status.status === 'confirmed') {
        log.info({attempt, elapsedMs, txHash}, 'trade confirmed');
        return;
      }
      if (status.status === 'failed') {
        log.error({attempt, elapsedMs, txHash}, 'trade failed on chain');
        throw new ArcusExecutionFailedError(
          `Trade ${txHash} failed on chain`,
          tradeId,
          txHash,
        );
      }

      if (attempt < MAX_POLL_ATTEMPTS) await this.sleep(POLL_INTERVAL_MS);
    }

    const budgetSeconds = (MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000;
    log.error(
      {attempts: MAX_POLL_ATTEMPTS, txHash},
      'status poll budget exhausted',
    );
    throw new ArcusPollTimeoutError(
      `Trade ${txHash} did not settle within ${budgetSeconds}s. It may still land — check the transaction on chain.`,
      tradeId,
      txHash,
    );
  }
}
