/** Inputs and outputs of an Arcus spot buy. */

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
