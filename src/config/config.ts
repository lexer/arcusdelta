/**
 * Loads and validates bot configuration from the environment.
 *
 * Fails fast: an invalid or incomplete environment throws {@link ConfigError}
 * at startup rather than surfacing as a failure mid-trade.
 */

import type {z, ZodTypeAny} from 'zod';
import dotenv from 'dotenv';
import {envSchema, marketDataEnvSchema} from './env.schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * What a read-only market-data command needs. Deliberately excludes `seed`:
 * `npm run funding` reads public data only and must not require a production
 * wallet mnemonic just to start.
 */
export interface MarketDataConfig {
  readonly chainId: number;
  readonly arcusRouterUrl: string;
  readonly arcusApiUrl: string;
  readonly fundingLookbackDays: number;
  readonly fundingRequestIntervalMs: number;
}

/**
 * Validated configuration. `seed` is secret and must never be logged.
 *
 * Every field below `arcusRouterUrl` is a *default*: the fallback a
 * `symbols.json` entry falls back to when it doesn't override that field
 * itself. There is no longer a single global stock token — see
 * `symbols.ts` for the per-symbol list.
 */
export interface Config extends MarketDataConfig {
  readonly seed: string;
  readonly rpcUrl: string;
  /**
   * Secret, like `seed`. Undefined until `npm run apikey` has been run; only
   * the perps order path requires it.
   */
  readonly arcusApiPrivateKey: string | undefined;
  readonly arcusAccountIndex: number;
  /** Fallback only; a symbol with no amount from either source is a config error. */
  readonly usdgBuyAmount: string | undefined;
  readonly slippageBps: number;
  readonly rangeDeviationPercent: number;
  readonly poolFee: number;
  readonly lpSlippageBps: number;
  readonly mintDeadlineSeconds: number;
  readonly poolCheckIntervalSeconds: number;
  readonly exitConfirmations: number;
  readonly closeSlippageBps: number;
  readonly twapChunks: number;
  readonly twapIntervalSeconds: number;
  readonly maxPriceImpactBps: number;
}

export type EnvSource = Record<string, string | undefined>;

function readDotenv(): EnvSource {
  dotenv.config();
  return process.env;
}

/** Shared so both loaders report a bad environment the same way. */
function parseEnv<S extends ZodTypeAny>(
  schema: S,
  source: EnvSource,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration — ${details}`);
  }
  return result.data;
}

export function loadMarketDataConfig(
  source: EnvSource = readDotenv(),
): MarketDataConfig {
  const env = parseEnv(marketDataEnvSchema, source);
  return Object.freeze({
    chainId: env.CHAIN_ID,
    arcusRouterUrl: env.ARCUS_ROUTER_URL,
    arcusApiUrl: env.ARCUS_API_URL,
    fundingLookbackDays: env.FUNDING_LOOKBACK_DAYS,
    fundingRequestIntervalMs: env.FUNDING_REQUEST_INTERVAL_MS,
  });
}

export function loadConfig(source: EnvSource = readDotenv()): Config {
  const env = parseEnv(envSchema, source);
  return Object.freeze({
    seed: env.SEED,
    rpcUrl: env.RPC_URL,
    arcusApiPrivateKey: env.ARCUS_API_PRIVATE_KEY,
    arcusAccountIndex: env.ARCUS_ACCOUNT_INDEX,
    chainId: env.CHAIN_ID,
    arcusRouterUrl: env.ARCUS_ROUTER_URL,
    arcusApiUrl: env.ARCUS_API_URL,
    fundingLookbackDays: env.FUNDING_LOOKBACK_DAYS,
    fundingRequestIntervalMs: env.FUNDING_REQUEST_INTERVAL_MS,
    usdgBuyAmount: env.USDG_BUY_AMOUNT,
    slippageBps: env.SLIPPAGE_BPS,
    rangeDeviationPercent: env.RANGE_DEVIATION_PERCENT,
    poolFee: env.POOL_FEE,
    lpSlippageBps: env.LP_SLIPPAGE_BPS,
    mintDeadlineSeconds: env.MINT_DEADLINE_SECONDS,
    poolCheckIntervalSeconds: env.POOL_CHECK_INTERVAL_SECONDS,
    exitConfirmations: env.EXIT_CONFIRMATIONS,
    closeSlippageBps: env.CLOSE_SLIPPAGE_BPS,
    twapChunks: env.TWAP_CHUNKS,
    twapIntervalSeconds: env.TWAP_INTERVAL_SECONDS,
    maxPriceImpactBps: env.MAX_PRICE_IMPACT_BPS,
  });
}

/**
 * Config fields that are safe to log — everything except the two secrets,
 * `seed` and `arcusApiPrivateKey`. Both are additionally covered by the pino
 * redaction paths, so omitting them here is the first of two guards.
 */
export function loggableConfig(config: Config): Record<string, unknown> {
  return {
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    arcusRouterUrl: config.arcusRouterUrl,
    arcusApiUrl: config.arcusApiUrl,
    arcusAccountIndex: config.arcusAccountIndex,
    /** Whether a key is configured — never the key itself. */
    arcusApiKeyConfigured: config.arcusApiPrivateKey !== undefined,
    fundingLookbackDays: config.fundingLookbackDays,
    fundingRequestIntervalMs: config.fundingRequestIntervalMs,
    usdgBuyAmount: config.usdgBuyAmount,
    slippageBps: config.slippageBps,
    rangeDeviationPercent: config.rangeDeviationPercent,
    poolFee: config.poolFee,
    lpSlippageBps: config.lpSlippageBps,
    mintDeadlineSeconds: config.mintDeadlineSeconds,
    poolCheckIntervalSeconds: config.poolCheckIntervalSeconds,
    exitConfirmations: config.exitConfirmations,
    closeSlippageBps: config.closeSlippageBps,
    twapChunks: config.twapChunks,
    twapIntervalSeconds: config.twapIntervalSeconds,
    maxPriceImpactBps: config.maxPriceImpactBps,
  };
}
