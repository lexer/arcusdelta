/**
 * Loads and validates bot configuration from the environment.
 *
 * Fails fast: an invalid or incomplete environment throws {@link ConfigError}
 * at startup rather than surfacing as a failure mid-trade.
 */

import dotenv from 'dotenv';
import {envSchema} from './env.schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validated configuration. `seed` is secret and must never be logged.
 *
 * Every field below `arcusRouterUrl` is a *default*: the fallback a
 * `symbols.json` entry falls back to when it doesn't override that field
 * itself. There is no longer a single global stock token — see
 * `symbols.ts` for the per-symbol list.
 */
export interface Config {
  readonly seed: string;
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly arcusRouterUrl: string;
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
}

export type EnvSource = Record<string, string | undefined>;

function readDotenv(): EnvSource {
  dotenv.config();
  return process.env;
}

export function loadConfig(source: EnvSource = readDotenv()): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration — ${details}`);
  }

  const env = result.data;
  return Object.freeze({
    seed: env.SEED,
    rpcUrl: env.RPC_URL,
    chainId: env.CHAIN_ID,
    arcusRouterUrl: env.ARCUS_ROUTER_URL,
    usdgBuyAmount: env.USDG_BUY_AMOUNT,
    slippageBps: env.SLIPPAGE_BPS,
    rangeDeviationPercent: env.RANGE_DEVIATION_PERCENT,
    poolFee: env.POOL_FEE,
    lpSlippageBps: env.LP_SLIPPAGE_BPS,
    mintDeadlineSeconds: env.MINT_DEADLINE_SECONDS,
    poolCheckIntervalSeconds: env.POOL_CHECK_INTERVAL_SECONDS,
    exitConfirmations: env.EXIT_CONFIRMATIONS,
    closeSlippageBps: env.CLOSE_SLIPPAGE_BPS,
  });
}

/** Config fields that are safe to log — everything except the seed. */
export function loggableConfig(config: Config): Record<string, unknown> {
  return {
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    arcusRouterUrl: config.arcusRouterUrl,
    usdgBuyAmount: config.usdgBuyAmount,
    slippageBps: config.slippageBps,
    rangeDeviationPercent: config.rangeDeviationPercent,
    poolFee: config.poolFee,
    lpSlippageBps: config.lpSlippageBps,
    mintDeadlineSeconds: config.mintDeadlineSeconds,
    poolCheckIntervalSeconds: config.poolCheckIntervalSeconds,
    exitConfirmations: config.exitConfirmations,
    closeSlippageBps: config.closeSlippageBps,
  };
}
