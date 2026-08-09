/**
 * Structured logging for the bot.
 *
 * Every operation runs under a child logger bound to a `tradeId` so a single
 * trade can be traced end to end through the logs. Redaction paths are a
 * second guard on top of never passing secrets to the logger in the first
 * place.
 *
 * Lines go to stdout and, when a `filePath` is given, to a daily JSONL file as
 * well. Redaction is configured on the pino instance rather than per stream,
 * so it applies to both — a secret cannot reach the file by a path that
 * bypasses the console.
 */

import {createWriteStream, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {multistream, pino, type Logger} from 'pino';

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

export interface LoggerOptions {
  readonly level?: string;
  /**
   * Appends every line to this file as well as stdout. The parent directory
   * is created if missing. Omit to log only to stdout — which is what tests
   * do, so a test run never writes to the operator's journal.
   */
  readonly filePath?: string;
}

/** `logs/arcusdelta-YYYY-MM-DD.jsonl` — one file per UTC day. */
export function dailyLogFile(directory: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `${directory}/arcusdelta-${day}.jsonl`;
}

export function createLogger(
  levelOrOptions: string | LoggerOptions = {},
): Logger {
  const options: LoggerOptions =
    typeof levelOrOptions === 'string'
      ? {level: levelOrOptions}
      : levelOrOptions;
  const level = options.level ?? process.env['LOG_LEVEL'] ?? 'info';
  const config = {
    level,
    redact: {paths: REDACTED_PATHS, censor: '[redacted]'},
    base: null,
  };

  if (options.filePath === undefined) return pino(config);

  mkdirSync(dirname(options.filePath), {recursive: true});
  return pino(
    config,
    multistream([
      {stream: process.stdout, level},
      {stream: createWriteStream(options.filePath, {flags: 'a'}), level},
    ]),
  );
}

/** Scopes a logger to one trade so every line carries the same correlation id. */
export function forTrade(logger: Logger, tradeId: string): Logger {
  return logger.child({tradeId});
}
