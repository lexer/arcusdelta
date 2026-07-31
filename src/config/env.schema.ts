/**
 * Schema for every environment variable the bot reads.
 *
 * Invariant: `SEED` is a production wallet mnemonic. It is parsed here but must
 * never be logged, serialized, or included in an error message.
 */

import {z} from 'zod';

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const address = z
  .string()
  .regex(HEX_ADDRESS, 'must be a 0x-prefixed 20-byte address')
  .transform(value => value as `0x${string}`);

export const envSchema = z.object({
  SEED: z.string().min(1, 'SEED is required (production wallet mnemonic)'),
  RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  ARCUS_ROUTER_URL: z
    .string()
    .url()
    .default('https://router.spot.arcus.xyz/v1'),
  STOCK_TOKEN_ADDRESS: address,
  USDG_BUY_AMOUNT: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a positive decimal number')
    .refine(value => Number(value) > 0, 'must be greater than zero'),
  SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(1),

  // Uniswap v4 liquidity position.
  RANGE_DEVIATION_PERCENT: z.coerce
    .number()
    .positive('must be greater than zero')
    .max(100, 'must be at most 100')
    .default(3),
  /** v4 fee units (hundredths of a bip). 3000 = 0.3%. */
  POOL_FEE: z.coerce.number().int().min(0).max(1_000_000).default(3_000),
  /** Must match the initialized pool exactly; v4 does not derive it from the fee. */
  POOL_TICK_SPACING: z.coerce.number().int().positive().default(60),
  LP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),
  MINT_DEADLINE_SECONDS: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof envSchema>;
