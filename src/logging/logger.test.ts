import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {describe, expect, it} from 'vitest';
import {pino} from 'pino';
import {createLogger, dailyLogFile, forTrade} from './logger.js';

function captureLines(): {lines: string[]; stream: {write(s: string): void}} {
  const lines: string[] = [];
  return {lines, stream: {write: (s: string) => void lines.push(s)}};
}

describe('forTrade', () => {
  it('binds the trade id to every line', () => {
    const {lines, stream} = captureLines();
    const logger = forTrade(pino({base: null}, stream), 'trade-1');

    logger.info({step: 'quote'}, 'fetching quote');

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['tradeId']).toBe('trade-1');
    expect(entry['step']).toBe('quote');
  });
});

describe('dailyLogFile', () => {
  it('names one file per UTC day', () => {
    expect(dailyLogFile('logs', new Date('2026-08-09T23:59:59Z'))).toBe(
      'logs/arcusdelta-2026-08-09.jsonl',
    );
  });
});

describe('file logging', () => {
  it('appends structured lines to the file, creating the directory', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'logtest-')),
      'nested',
      'run.jsonl',
    );
    const logger = createLogger({level: 'info', filePath: path});

    logger.info({symbol: 'NVDA'}, 'perp order accepted');
    await delay(50);

    const entry = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(entry.msg).toBe('perp order accepted');
    expect(entry.symbol).toBe('NVDA');
  });

  it('redacts secrets on the way to the file, not just the console', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'logtest-')), 'run.jsonl');
    const logger = createLogger({level: 'info', filePath: path});

    logger.info(
      {seed: 'correct horse battery staple', privateKeyHex: 'deadbeef'},
      'config loaded',
    );
    await delay(50);

    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('correct horse');
    expect(written).not.toContain('deadbeef');
    expect(written).toContain('[redacted]');
  });

  it('writes no file when no path is given', () => {
    expect(() => createLogger('silent')).not.toThrow();
  });
});

describe('redaction', () => {
  it('censors secret-bearing fields', () => {
    const {lines, stream} = captureLines();
    const logger = pino(
      {
        base: null,
        redact: {paths: ['seed', '*.seed'], censor: '[redacted]'},
      },
      stream,
    );

    logger.info({seed: 'correct horse battery staple'}, 'config loaded');

    expect(lines[0]).not.toContain('correct horse');
    expect(lines[0]).toContain('[redacted]');
  });
});
