/**
 * Schema for one entry in `symbols.json`.
 *
 * Only `symbol` and `stockTokenAddress` are required; every strategy field is
 * optional and falls back to the corresponding `.env` default when omitted.
 *
 * `usdgBuyAmount` is the **pair** notional: the USDG spent acquiring the spot
 * leg, with the perp short sized to match it.
 */

import {z} from 'zod';
import {address, usdgAmount} from './env.schema.js';

export const symbolEntrySchema = z.object({
  symbol: z.string().min(1, 'symbol is required'),
  stockTokenAddress: address,
  usdgBuyAmount: usdgAmount.optional(),
  slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
  twapChunks: z.coerce.number().int().positive().optional(),
  twapIntervalSeconds: z.coerce.number().int().positive().optional(),
  maxPriceImpactBps: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const symbolsFileSchema = z.array(symbolEntrySchema);

export type SymbolEntry = z.infer<typeof symbolEntrySchema>;
