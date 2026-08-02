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
  ArcusQuoteError,
  ArcusSubmissionError,
  ArcusPermitError,
  QuoteValidationError,
} from './errors.js';
import type {TokenResolver} from './tokenResolver.js';
import type {
  BuyRequest,
  BuyResult,
  QuotePreview,
  SellRequest,
} from './types.js';

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
  readonly sleep?: Sleep;
}

export class SpotSwapService {
  private readonly router: SpotRouter;
  private readonly wallet: WalletProvider;
  private readonly tokens: TokenResolver;
  private readonly logger: Logger;
  private readonly chainId: number;
  private readonly sellSymbol: string;
  private readonly sleep: Sleep;

  constructor(options: SpotSwapServiceOptions) {
    this.router = options.router;
    this.wallet = options.wallet;
    this.tokens = options.tokens;
    this.logger = options.logger;
    this.chainId = options.chainId;
    this.sellSymbol = options.sellSymbol;
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

  async executeBuy(request: BuyRequest): Promise<BuyResult> {
    const log = this.logger.child({tradeId: request.tradeId});
    const startedAt = Date.now();
    log.info(
      {
        buyToken: request.buyToken,
        sellAmount: request.sellAmount,
        slippageBps: request.slippageBps,
      },
      'buy started',
    );

    const {quote, sellToken, buyToken} = await this.prepare(request, log);
    const result = await this.settle(
      quote,
      request.tradeId,
      sellToken.address,
      buyToken.address,
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
    log.info(
      {
        sellToken: request.sellToken,
        sellAmountAtoms: request.sellAmountAtoms.toString(),
        slippageBps: request.slippageBps,
      },
      'sell started',
    );

    const sellToken = await this.tokens.byAddress(request.sellToken);
    const buyToken = await this.tokens.bySymbol(this.sellSymbol);
    const sellAmountAtoms = request.sellAmountAtoms.toString();

    const quote = await this.quoteAndValidate(
      request.tradeId,
      sellToken,
      buyToken,
      sellAmountAtoms,
      request.slippageBps,
      log,
    );
    const result = await this.settle(
      quote,
      request.tradeId,
      sellToken.address,
      buyToken.address,
      log,
    );

    log.info({...result, elapsedMs: Date.now() - startedAt}, 'sell completed');
    return result;
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
  ): Promise<BuyResult> {
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
        tradeId,
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
      tradeId,
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
