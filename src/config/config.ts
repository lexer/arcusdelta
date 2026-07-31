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

/** Validated configuration. `seed` is secret and must never be logged. */
export interface Config {
  readonly seed: string;
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly arcusRouterUrl: string;
  readonly stockTokenAddress: `0x${string}`;
  readonly usdgBuyAmount: string;
  readonly slippageBps: number;
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
    stockTokenAddress: env.STOCK_TOKEN_ADDRESS,
    usdgBuyAmount: env.USDG_BUY_AMOUNT,
    slippageBps: env.SLIPPAGE_BPS,
  });
}

/** Config fields that are safe to log — everything except the seed. */
export function loggableConfig(config: Config): Record<string, unknown> {
  return {
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    arcusRouterUrl: config.arcusRouterUrl,
    stockTokenAddress: config.stockTokenAddress,
    usdgBuyAmount: config.usdgBuyAmount,
    slippageBps: config.slippageBps,
  };
}
