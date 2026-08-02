/**
 * Schema for one entry in `symbols.json`.
 *
 * Only `symbol` and `stockTokenAddress` are required; every strategy field is
 * optional and falls back to the corresponding `.env` default when omitted.
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
});

export const symbolsFileSchema = z.array(symbolEntrySchema);

export type SymbolEntry = z.infer<typeof symbolEntrySchema>;
