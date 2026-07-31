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
import {parseUnits, type Hex} from 'viem';
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
import type {BuyRequest, BuyResult} from './types.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;

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

export interface SpotBuyServiceOptions {
  readonly router: SpotRouter;
  readonly wallet: WalletProvider;
  readonly tokens: TokenResolver;
  readonly logger: Logger;
  readonly chainId: number;
  /** Symbol of the token spent on every buy. */
  readonly sellSymbol: string;
  readonly sleep?: Sleep;
}

export class SpotBuyService {
  private readonly router: SpotRouter;
  private readonly wallet: WalletProvider;
  private readonly tokens: TokenResolver;
  private readonly logger: Logger;
  private readonly chainId: number;
  private readonly sellSymbol: string;
  private readonly sleep: Sleep;

  constructor(options: SpotBuyServiceOptions) {
    this.router = options.router;
    this.wallet = options.wallet;
    this.tokens = options.tokens;
    this.logger = options.logger;
    this.chainId = options.chainId;
    this.sellSymbol = options.sellSymbol;
    this.sleep = options.sleep ?? defaultSleep;
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

    const quote = await this.fetchQuote(
      request,
      sellToken,
      buyToken,
      sellAmountAtoms,
      log,
    );
    this.validateQuote(quote, request.tradeId, sellAmountAtoms, log);

    const permit = await this.buildPermit(quote, request.tradeId, log);

    log.info('signing quote');
    const signed = await signQuote(quote, this.wallet.getWalletClient(), {
      ...(permit ? {permits: [permit]} : {}),
    });
    log.info('quote signed');

    const submission = await this.submit(signed, request.tradeId, log);
    const orderId =
      submission.venue === 'arcus' ? submission.orderId : undefined;

    await this.pollUntilTerminal(
      orderId ?? submission.txHash,
      submission.txHash,
      request.tradeId,
      log,
    );

    const result: BuyResult = {
      tradeId: request.tradeId,
      txHash: submission.txHash,
      orderId,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      minBuyAmount: quote.arcus.minAmountOut,
    };
    log.info({...result, elapsedMs: Date.now() - startedAt}, 'buy completed');
    return result;
  }

  private async fetchQuote(
    request: BuyRequest,
    sellToken: TokenInfo,
    buyToken: TokenInfo,
    sellAmountAtoms: string,
    log: Logger,
  ): Promise<ArcusFirmQuote> {
    log.info({venue: 'arcus'}, 'requesting quote');
    const response = await this.router.getQuote({
      chainId: this.chainId,
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      sellAmount: sellAmountAtoms,
      taker: this.wallet.getAccount().address,
      slippageBps: request.slippageBps,
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
        request.tradeId,
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
