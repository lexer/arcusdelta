/**
 * Error types for the Arcus buy flow.
 *
 * Each carries structured context so log lines and CLI output can render the
 * failure without parsing message strings.
 */

import type {Hex} from 'viem';

export abstract class ArcusError extends Error {
  readonly tradeId: string;

  constructor(message: string, tradeId: string) {
    super(message);
    this.name = new.target.name;
    this.tradeId = tradeId;
  }
}

/** The router returned no usable Arcus quote. */
export class ArcusQuoteError extends ArcusError {
  readonly venueErrors: readonly string[];

  constructor(message: string, tradeId: string, venueErrors: string[] = []) {
    super(message, tradeId);
    this.venueErrors = venueErrors;
  }
}

/** The returned quote failed a pre-signing safety check. Nothing was signed. */
export class QuoteValidationError extends ArcusError {}

/**
 * The sell token cannot produce an EIP-2612 permit. Recovering needs a one-time
 * on-chain `approve` to Permit2, which this bot deliberately does not send on
 * its own because it spends gas without operator confirmation.
 */
export class ArcusPermitError extends ArcusError {
  readonly token: Hex;
  readonly spender: Hex;
  readonly currentAllowance: bigint;

  constructor(
    message: string,
    tradeId: string,
    token: Hex,
    spender: Hex,
    currentAllowance: bigint,
  ) {
    super(message, tradeId);
    this.token = token;
    this.spender = spender;
    this.currentAllowance = currentAllowance;
  }
}

/** The router rejected the signed quote. */
export class ArcusSubmissionError extends ArcusError {}

/** The trade was submitted on-chain but settled as failed. */
export class ArcusExecutionFailedError extends ArcusError {
  readonly txHash: Hex;

  constructor(message: string, tradeId: string, txHash: Hex) {
    super(message, tradeId);
    this.txHash = txHash;
  }
}

/**
 * The trade did not reach a terminal state within the polling budget. It may
 * still settle — `txHash` is the handle for checking on-chain.
 */
export class ArcusPollTimeoutError extends ArcusError {
  readonly txHash: Hex;

  constructor(message: string, tradeId: string, txHash: Hex) {
    super(message, tradeId);
    this.txHash = txHash;
  }
}
