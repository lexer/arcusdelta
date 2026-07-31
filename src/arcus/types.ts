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
  readonly txHash: Hex;
  readonly orderId: Hex | undefined;
  /** Atomic units of the sell token actually committed. */
  readonly sellAmount: string;
  /** Atomic units of the buy token quoted. */
  readonly buyAmount: string;
  /** Atomic units of the buy token guaranteed by the quote's slippage bound. */
  readonly minBuyAmount: string;
}
