import {describe, expect, it} from 'vitest';
import {pino} from 'pino';
import {forTrade} from './logger.js';

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
