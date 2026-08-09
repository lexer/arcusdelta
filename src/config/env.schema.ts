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

  /** Directory for the daily structured run logs. Gitignored. */
  LOG_DIR: z.string().min(1).default('logs'),
  /**
   * Append-only record of every fill and funding payment. Kept separate from
   * the daily run logs because it is a contiguous ledger, not a debug trail.
   */
  JOURNAL_PATH: z.string().min(1).default('logs/executions.jsonl'),
});

export const envSchema = marketDataEnvSchema.extend({
  SEED: z.string().min(1, 'SEED is required (production wallet mnemonic)'),
  RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),

  /**
   * Ed25519 private key for the Arcus perps API, 32 bytes of hex. Generate
   * and register it with `npm run apikey`.
   *
   * A secret of the same class as `SEED`: anything holding it can place and
   * cancel orders on the perps account. Optional so read-only and spot-only
   * commands still start without it; the perps order path fails fast when it
   * is missing.
   */
  ARCUS_API_PRIVATE_KEY: z
    .string()
    .regex(
      /^(0x)?[0-9a-fA-F]{64}$/,
      'must be 32 bytes of hex (64 characters), optionally 0x-prefixed',
    )
    .optional(),
  /** Subaccount to trade. 0 unless you deliberately use another. */
  ARCUS_ACCOUNT_INDEX: z.coerce.number().int().min(0).max(9).default(0),
  /**
   * Fallback when a symbols.json entry omits its own usdgBuyAmount. No
   * default of its own: a symbol with no amount from either source is a
   * config error naming that symbol, not a silently-assumed number.
   */
  USDG_BUY_AMOUNT: usdgAmount.optional(),
  SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(1),

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

  /**
   * Realizable PnL, in basis points of the capital deployed, at which the
   * pair monitor flags a position as worth closing. May be negative, which
   * expresses a stop rather than a target.
   */
  MIN_CLOSE_PROFIT_BPS: z.coerce
    .number()
    .int()
    .min(-10_000)
    .max(10_000)
    .default(25),
  /** How far spot and perp sizes may drift before a pair is disowned. */
  MAX_DELTA_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  PAIR_CHECK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type MarketDataEnv = z.infer<typeof marketDataEnvSchema>;
export type Env = z.infer<typeof envSchema>;
