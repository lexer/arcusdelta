/**
 * Schema for one entry in `symbols.json`.
 *
 * Only `symbol` and `stockTokenAddress` are required; every strategy field is
 * optional and falls back to the corresponding `.env` default when omitted.
 *
 * The delta-neutral strategy uses `usdgBuyAmount` (the pair notional),
 * `slippageBps`, `twapChunks`, `twapIntervalSeconds`, and
 * `maxPriceImpactBps`. The Uniswap fields below it — `poolFee`,
 * `rangeDeviationPercent`, `lpSlippageBps`, `mintDeadlineSeconds`,
 * `poolCheckIntervalSeconds`, `exitConfirmations`, `closeSlippageBps` — belong
 * to the liquidity-position strategy and are removed along with it (plan 0011,
 * phase 6). They are still accepted so an existing `symbols.json` keeps
 * loading in the meantime.
 */

import {z} from 'zod';
import {address, usdgAmount} from './env.schema.js';

export const symbolEntrySchema = z.object({
  symbol: z.string().min(1, 'symbol is required'),
  stockTokenAddress: address,
  usdgBuyAmount: usdgAmount.optional(),
  poolFee: z.coerce.number().int().min(0).max(1_000_000).optional(),
  rangeDeviationPercent: z.coerce
    .number()
    .positive('must be greater than zero')
    .max(100, 'must be at most 100')
    .optional(),
  slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
  lpSlippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
  mintDeadlineSeconds: z.coerce.number().int().positive().optional(),
  poolCheckIntervalSeconds: z.coerce.number().int().positive().optional(),
  exitConfirmations: z.coerce.number().int().positive().optional(),
  closeSlippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
  twapChunks: z.coerce.number().int().positive().optional(),
  twapIntervalSeconds: z.coerce.number().int().positive().optional(),
  maxPriceImpactBps: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const symbolsFileSchema = z.array(symbolEntrySchema);

export type SymbolEntry = z.infer<typeof symbolEntrySchema>;
