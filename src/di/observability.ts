/**
 * Logger and journal construction, part of the composition root.
 *
 * Centralized so a new command cannot accidentally log only to the console and
 * leave no durable record of what it did with real funds. `container.ts` uses
 * these for every wallet-backed command; the two read-only entrypoints that
 * need no wallet call them directly.
 */

import type {MarketDataConfig} from '../config/config.js';
import {
  createFileJournal,
  createNullJournal,
  type ExecutionJournal,
} from '../journal/executionJournal.js';
import {createLogger, dailyLogFile, type Logger} from '../logging/logger.js';

/** Console plus a daily JSONL file under `LOG_DIR`. */
export function createRunLogger(config: MarketDataConfig): Logger {
  return createLogger({filePath: dailyLogFile(config.logDir)});
}

/**
 * The execution journal, or a discarding one under `--dry-run`.
 *
 * A rehearsal must not leave entries that later read as real fills.
 */
export function createJournal(
  config: MarketDataConfig,
  dryRun = false,
): ExecutionJournal {
  return dryRun ? createNullJournal() : createFileJournal(config.journalPath);
}
