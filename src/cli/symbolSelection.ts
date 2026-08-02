/**
 * Loads `symbols.json` from the repo root and narrows it to `--symbol`,
 * shared by every CLI entrypoint that operates on one or more configured
 * symbols.
 */

import type {Config} from '../config/config.js';
import {
  loadSymbols,
  selectSymbols,
  type SymbolConfig,
} from '../config/symbols.js';

const SYMBOLS_PATH = 'symbols.json';

export function loadSelectedSymbols(
  config: Config,
  ticker: string | undefined,
): SymbolConfig[] {
  const symbols = loadSymbols(SYMBOLS_PATH, config);
  return selectSymbols(symbols, ticker);
}
