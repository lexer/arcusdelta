import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ConfigError, loadConfig} from './config.js';
import {loadSymbols, selectSymbols} from './symbols.js';

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const TEST_SEED = 'test test test test test test test test test test test junk';

function defaults(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({SEED: TEST_SEED, USDG_BUY_AMOUNT: '100', ...overrides});
}

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arcusamm-symbols-'));
  filePath = join(dir, 'symbols.json');
});

afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

function write(content: unknown): void {
  writeFileSync(filePath, JSON.stringify(content));
}

describe('loadSymbols', () => {
  it('resolves a symbol with no overrides against the defaults', () => {
    write([{symbol: 'NVDA', stockTokenAddress: NVDA}]);

    const [resolved] = loadSymbols(filePath, defaults());

    expect(resolved).toMatchObject({
      symbol: 'NVDA',
      stockTokenAddress: NVDA,
      usdgBuyAmount: '100',
      poolFee: 3000,
      rangeDeviationPercent: 3,
      lpSlippageBps: 50,
      exitConfirmations: 3,
    });
  });

  it('lets a per-symbol field override the default', () => {
    write([
      {
        symbol: 'NVDA',
        stockTokenAddress: NVDA,
        poolFee: 500,
        usdgBuyAmount: '25',
      },
    ]);

    const [resolved] = loadSymbols(filePath, defaults());

    expect(resolved!.poolFee).toBe(500);
    expect(resolved!.usdgBuyAmount).toBe('25');
    // Untouched fields still fall back.
    expect(resolved!.rangeDeviationPercent).toBe(3);
  });

  it('resolves multiple symbols independently', () => {
    write([
      {symbol: 'NVDA', stockTokenAddress: NVDA, poolFee: 500},
      {symbol: 'AAPL', stockTokenAddress: AAPL},
    ]);

    const resolved = loadSymbols(filePath, defaults());

    expect(resolved).toHaveLength(2);
    expect(resolved.find(s => s.symbol === 'NVDA')?.poolFee).toBe(500);
    expect(resolved.find(s => s.symbol === 'AAPL')?.poolFee).toBe(3000);
  });

  it('rejects a symbol with no usdgBuyAmount and no fallback', () => {
    write([{symbol: 'NVDA', stockTokenAddress: NVDA}]);

    expect(() =>
      loadSymbols(filePath, defaults({USDG_BUY_AMOUNT: undefined})),
    ).toThrow(/NVDA.*usdgBuyAmount/is);
  });

  it('accepts a symbol-level usdgBuyAmount even with no global fallback', () => {
    write([{symbol: 'NVDA', stockTokenAddress: NVDA, usdgBuyAmount: '10'}]);

    const [resolved] = loadSymbols(
      filePath,
      defaults({USDG_BUY_AMOUNT: undefined}),
    );

    expect(resolved!.usdgBuyAmount).toBe('10');
  });

  it('rejects duplicate symbol names', () => {
    write([
      {symbol: 'NVDA', stockTokenAddress: NVDA},
      {symbol: 'NVDA', stockTokenAddress: AAPL},
    ]);

    expect(() => loadSymbols(filePath, defaults())).toThrow(/more than once/);
  });

  it('rejects an empty list', () => {
    write([]);

    expect(() => loadSymbols(filePath, defaults())).toThrow(ConfigError);
  });

  it('rejects a malformed token address with a per-field error', () => {
    write([{symbol: 'NVDA', stockTokenAddress: '0xdead'}]);

    expect(() => loadSymbols(filePath, defaults())).toThrow(ConfigError);
  });

  it('rejects invalid JSON', () => {
    writeFileSync(filePath, '{not json');

    expect(() => loadSymbols(filePath, defaults())).toThrow(/not valid JSON/);
  });

  it('rejects a missing file with a helpful message', () => {
    expect(() => loadSymbols(join(dir, 'missing.json'), defaults())).toThrow(
      /symbols\.example\.json/,
    );
  });
});

describe('selectSymbols', () => {
  const resolved = () => {
    write([
      {symbol: 'NVDA', stockTokenAddress: NVDA},
      {symbol: 'AAPL', stockTokenAddress: AAPL},
    ]);
    return loadSymbols(filePath, defaults());
  };

  it('returns every symbol when no ticker is given', () => {
    const symbols = resolved();

    expect(selectSymbols(symbols, undefined)).toHaveLength(2);
  });

  it('narrows to the matching symbol', () => {
    const symbols = resolved();

    const selected = selectSymbols(symbols, 'AAPL');

    expect(selected).toHaveLength(1);
    expect(selected[0]?.symbol).toBe('AAPL');
  });

  it('rejects an unknown ticker, listing what is available', () => {
    const symbols = resolved();

    expect(() => selectSymbols(symbols, 'TSLA')).toThrow(
      /NVDA.*AAPL|AAPL.*NVDA/,
    );
  });
});
