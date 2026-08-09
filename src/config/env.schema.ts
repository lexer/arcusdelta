/**
 * Schema for every environment variable the bot reads.
 *
 * Invariant: `SEED` is a production wallet mnemonic. It is parsed here but must
 * never be logged, serialized, or included in an error message.
 */

import {z} from 'zod';

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Shared with `symbols.schema.ts`, since a symbol entry needs the same check. */
export const address = z
  .string()
  .regex(HEX_ADDRESS, 'must be a 0x-prefixed 20-byte address')
  .transform(value => value as `0x${string}`);

/** Shared with `symbols.schema.ts` for the same field on a symbol entry. */
export const usdgAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a positive decimal number')
  .refine(value => Number(value) > 0, 'must be greater than zero');

/**
 * The subset a read-only market-data command needs.
 *
 * Split out so `npm run funding` — which ranks public funding history and
 * touches no wallet — does not require `SEED` to be present just to start.
 */
export const marketDataEnvSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  ARCUS_ROUTER_URL: z
    .string()
    .url()
    .default('https://router.spot.arcus.xyz/v1'),
  /** Arcus perpetuals gateway origin. Testnet is https://api.testnet.arcus.xyz. */
  ARCUS_API_URL: z.string().url().default('https://api.arcus.xyz'),
  /**
   * How far back the funding analysis looks. Defaults to a quarter so at
   * least one ex-dividend date falls inside the window — dividends are passed
   * to longs through funding, so a shorter lookback systematically overstates
   * what a short actually earns.
   */
  FUNDING_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .max(3650)
    .default(90),
  /**
   * Delay between funding-history pages. `fundingRates` costs 20 weight
   * against a bucket that refills at 25/second, so anything under ~800ms is
   * throttled on a wide scan.
   */
  FUNDING_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
});

export const envSchema = marketDataEnvSchema.extend({
  SEED: z.string().min(1, 'SEED is required (production wallet mnemonic)'),
  RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  /**
   * Fallback when a symbols.json entry omits its own usdgBuyAmount. No
   * default of its own: a symbol with no amount from either source is a
   * config error naming that symbol, not a silently-assumed number.
   */
  USDG_BUY_AMOUNT: usdgAmount.optional(),
  SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(1),

  // Uniswap v3 liquidity position.
  RANGE_DEVIATION_PERCENT: z.coerce
    .number()
    .positive('must be greater than zero')
    .max(100, 'must be at most 100')
    .default(3),
  /** Fee units (hundredths of a bip). 3000 = 0.3%. tickSpacing is derived from this via the factory, not configured separately. */
  POOL_FEE: z.coerce.number().int().min(0).max(1_000_000).default(3_000),
  LP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),
  MINT_DEADLINE_SECONDS: z.coerce.number().int().positive().default(300),

  // Position monitoring.
  POOL_CHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  /** Consecutive out-of-range polls required before closing. */
  EXIT_CONFIRMATIONS: z.coerce.number().int().positive().default(3),
  CLOSE_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),

  /**
   * Arcus trade execution. 1 chunk (the default) disables TWAP: a buy or
   * sell executes exactly as one quote-sign-submit-poll cycle, same as
   * before this existed.
   */
  TWAP_CHUNKS: z.coerce.number().int().positive().default(1),
  TWAP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),

  /**
   * Refuse a buy (or TWAP chunk of one) whose price impact — vs a small
   * reference quote for the same pair — exceeds this many basis points.
   */
  MAX_PRICE_IMPACT_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
});

export type MarketDataEnv = z.infer<typeof marketDataEnvSchema>;
export type Env = z.infer<typeof envSchema>;
