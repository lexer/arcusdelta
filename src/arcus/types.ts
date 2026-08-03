/** Inputs and outputs of an Arcus spot buy. */

import type {RouteFee} from '@arcus-xyz/arcus-spot-sdk';
import type {Hex} from 'viem';

export interface BuyRequest {
  /** Correlation id shared by every log line for this trade. */
  readonly tradeId: string;
  /** Token to acquire. */
  readonly buyToken: Hex;
  /** Human decimal amount of the sell token to spend, e.g. '100'. */
  readonly sellAmount: string;
  /** Slippage tolerance in basis points. 1 bps = 0.01%. */
  readonly slippageBps: number;
  /** Split into this many chunks, each with its own quote. Omitted or <= 1 disables TWAP. */
  readonly twapChunks?: number;
  /** Delay between chunks. Only meaningful when twapChunks > 1. */
  readonly twapIntervalSeconds?: number;
  /**
   * Refuse this trade (or TWAP chunk of it) if its price impact vs a small
   * reference quote exceeds this many basis points. Omitted disables the check.
   */
  readonly maxPriceImpactBps?: number;
}

/**
 * Sells an exact on-chain balance back into the quote currency.
 *
 * Atoms, not a decimal string: the caller is spending a balance it read from
 * chain and must spend it exactly.
 */
export interface SellRequest {
  readonly tradeId: string;
  readonly sellToken: Hex;
  readonly sellAmountAtoms: bigint;
  readonly slippageBps: number;
  /** Split into this many chunks, each with its own quote. Omitted or <= 1 disables TWAP. */
  readonly twapChunks?: number;
  /** Delay between chunks. Only meaningful when twapChunks > 1. */
  readonly twapIntervalSeconds?: number;
}

/** What a buy would do right now, in human units. Nothing is committed. */
export interface QuotePreview {
  readonly tradeId: string;
  readonly venue: 'arcus';
  readonly sellSymbol: string;
  readonly sellAmount: string;
  readonly buySymbol: string;
  readonly buyAmount: string;
  /** Guaranteed by the quote's slippage bound. */
  readonly minBuyAmount: string;
  /** Sell units per buy unit. Display only. */
  readonly pricePerUnit: string;
  readonly expiresAt: string;
  readonly fees: readonly RouteFee[];
}

export interface BuyResult {
  readonly tradeId: string;
  /** One hash per chunk executed; a single-element array when TWAP is off. */
  readonly txHashes: readonly Hex[];
  /** Only meaningful for a single-chunk trade; undefined when chunked. */
  readonly orderId: Hex | undefined;
  /** Atomic units of the sell token actually committed, summed across chunks. */
  readonly sellAmount: string;
  /** Atomic units of the buy token received, summed across chunks. */
  readonly buyAmount: string;
  /** Atomic units of the buy token guaranteed, summed across chunks. */
  readonly minBuyAmount: string;
}
