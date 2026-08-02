/**
 * Loads and resolves `symbols.json` against the `.env` defaults.
 *
 * Fails fast, same as `config.ts`: a malformed file, a duplicate symbol name,
 * or a symbol with no `usdgBuyAmount` from either source throws
 * {@link ConfigError} at startup rather than surfacing mid-trade.
 */

import {readFileSync} from 'node:fs';
import type {Hex} from 'viem';
import {ConfigError, type Config} from './config.js';
import {symbolsFileSchema, type SymbolEntry} from './symbols.schema.js';

/** One symbol, fully resolved: every field required, no more fallbacks. */
export interface SymbolConfig {
  readonly symbol: string;
  readonly stockTokenAddress: Hex;
  readonly usdgBuyAmount: string;
  readonly poolFee: number;
  readonly rangeDeviationPercent: number;
  readonly slippageBps: number;
  readonly lpSlippageBps: number;
  readonly mintDeadlineSeconds: number;
  readonly poolCheckIntervalSeconds: number;
  readonly exitConfirmations: number;
  readonly closeSlippageBps: number;
  readonly twapChunks: number;
  readonly twapIntervalSeconds: number;
}

function resolveEntry(entry: SymbolEntry, defaults: Config): SymbolConfig {
  const usdgBuyAmount = entry.usdgBuyAmount ?? defaults.usdgBuyAmount;
  if (usdgBuyAmount === undefined) {
    throw new ConfigError(
      `Symbol "${entry.symbol}" has no usdgBuyAmount and USDG_BUY_AMOUNT ` +
        'is not set in .env as a fallback.',
    );
  }

  return {
    symbol: entry.symbol,
    stockTokenAddress: entry.stockTokenAddress,
    usdgBuyAmount,
    poolFee: entry.poolFee ?? defaults.poolFee,
    rangeDeviationPercent:
      entry.rangeDeviationPercent ?? defaults.rangeDeviationPercent,
    slippageBps: entry.slippageBps ?? defaults.slippageBps,
    lpSlippageBps: entry.lpSlippageBps ?? defaults.lpSlippageBps,
    mintDeadlineSeconds:
      entry.mintDeadlineSeconds ?? defaults.mintDeadlineSeconds,
    poolCheckIntervalSeconds:
      entry.poolCheckIntervalSeconds ?? defaults.poolCheckIntervalSeconds,
    exitConfirmations: entry.exitConfirmations ?? defaults.exitConfirmations,
    closeSlippageBps: entry.closeSlippageBps ?? defaults.closeSlippageBps,
    twapChunks: entry.twapChunks ?? defaults.twapChunks,
    twapIntervalSeconds:
      entry.twapIntervalSeconds ?? defaults.twapIntervalSeconds,
  };
}

export function loadSymbols(path: string, defaults: Config): SymbolConfig[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `Could not read ${path} — copy symbols.example.json to get started. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = symbolsFileSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid ${path} — ${details}`);
  }

  if (result.data.length === 0) {
    throw new ConfigError(`${path} lists no symbols.`);
  }

  const seen = new Set<string>();
  for (const entry of result.data) {
    if (seen.has(entry.symbol)) {
      throw new ConfigError(
        `Symbol "${entry.symbol}" appears more than once in ${path}.`,
      );
    }
    seen.add(entry.symbol);
  }

  return result.data.map(entry => resolveEntry(entry, defaults));
}

/** Resolves `--symbol` against the loaded list, or returns all of them. */
export function selectSymbols(
  symbols: readonly SymbolConfig[],
  ticker: string | undefined,
): SymbolConfig[] {
  if (ticker === undefined) return [...symbols];

  const match = symbols.find(s => s.symbol === ticker);
  if (!match) {
    const available = symbols.map(s => s.symbol).join(', ');
    throw new ConfigError(
      `Unknown symbol "${ticker}". Configured symbols: ${available}`,
    );
  }
  return [match];
}
