/**
 * Structured logging for the bot.
 *
 * Every operation runs under a child logger bound to a `tradeId` so a single
 * buy can be traced end to end through the logs. Redaction paths are a second
 * guard on top of never passing secrets to the logger in the first place.
 */

import {pino, type Logger} from 'pino';

export type {Logger};

const REDACTED_PATHS = [
  'seed',
  'SEED',
  'mnemonic',
  'privateKey',
  'privateKeyHex',
  'arcusApiPrivateKey',
  'ARCUS_API_PRIVATE_KEY',
  '*.seed',
  '*.SEED',
  '*.mnemonic',
  '*.privateKey',
  '*.privateKeyHex',
  '*.arcusApiPrivateKey',
  '*.ARCUS_API_PRIVATE_KEY',
];

export function createLogger(
  level = process.env['LOG_LEVEL'] ?? 'info',
): Logger {
  return pino({
    level,
    redact: {paths: REDACTED_PATHS, censor: '[redacted]'},
    base: null,
  });
}

/** Scopes a logger to one trade so every line carries the same correlation id. */
export function forTrade(logger: Logger, tradeId: string): Logger {
  return logger.child({tradeId});
}
