/**
 * Entrypoint for `npm run funding` — a read-only ranking of the tradable
 * universe by the funding a short perp would have collected.
 *
 * Public data only: no API key, no wallet, nothing signed. This is the command
 * that informs which symbols belong in `symbols.json`; it does not itself
 * decide anything.
 */

import {SpotRouterClient} from '@arcus-xyz/arcus-spot-sdk';
import {Command} from 'commander';
import {loadMarketDataConfig} from '../config/config.js';
import {
  analyzeFunding,
  FundingHistoryFetcher,
} from '../funding/fundingAnalyzer.js';
import {buildUniverse} from '../funding/universe.js';
import {createRunLogger} from '../di/observability.js';
import {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import {MarketRegistry} from '../perps/marketRegistry.js';
import {buildFundingReport} from './fundingCommand.js';
import {print} from './prompt.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('funding')
    .description(
      'Rank spot/perp tradable symbols by historical short funding carry',
    )
    .option('--days <n>', 'lookback window in days (default from .env)')
    .option('--symbol <ticker>', 'analyze only this symbol')
    .parse(process.argv);
  const options = program.opts<{days?: string; symbol?: string}>();

  const config = loadMarketDataConfig();
  const lookbackDays = options.days
    ? Number(options.days)
    : config.fundingLookbackDays;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    process.stderr.write('--days must be a positive number\n');
    return 1;
  }

  const logger = createRunLogger(config);
  const startedAt = Date.now();
  logger.info(
    {
      command: 'funding',
      lookbackDays,
      arcusApiUrl: config.arcusApiUrl,
      arcusRouterUrl: config.arcusRouterUrl,
      chainId: config.chainId,
    },
    'cli started',
  );

  const perps = new ArcusPerpsClient({
    baseUrl: config.arcusApiUrl,
    logger,
  });
  const registry = new MarketRegistry(perps);
  const router = new SpotRouterClient({baseUrl: config.arcusRouterUrl});

  const [specs, tokens] = await Promise.all([
    registry.all(),
    router.getTokenList(),
  ]);
  const {tradable, perpOnly} = buildUniverse(
    specs,
    tokens.filter(token => token.chainId === config.chainId),
  );
  logger.info(
    {tradable: tradable.length, perpOnly: perpOnly.length},
    'universe resolved',
  );

  const selected = options.symbol
    ? tradable.filter(
        pair => pair.symbol.toUpperCase() === options.symbol!.toUpperCase(),
      )
    : tradable;

  if (selected.length === 0) {
    const available = tradable.map(pair => pair.symbol).join(', ');
    process.stderr.write(
      options.symbol
        ? `"${options.symbol}" is not tradable on both venues. Available: ${available}\n`
        : 'No symbols are tradable on both venues right now.\n',
    );
    return 1;
  }

  print(
    `Scanning ${selected.length} symbol${selected.length === 1 ? '' : 's'} ` +
      `over ${lookbackDays} days — paced to stay inside the rate limit.`,
  );

  const analyses = await analyzeFunding({
    markets: selected,
    lookbackDays,
    fetcher: new FundingHistoryFetcher({
      client: perps,
      requestIntervalMs: config.fundingRequestIntervalMs,
    }),
    onProgress: (done, total, symbol) =>
      process.stderr.write(`\r  ${done}/${total}  ${symbol.padEnd(8)}`),
  });
  // Erase the progress line so it does not sit above the report.
  process.stderr.write('\r\u001b[K');

  print(buildFundingReport({analyses, lookbackDays}));

  if (perpOnly.length > 0) {
    print(
      `Perp-only (no spot token, cannot be paired): ${perpOnly.join(', ')}\n`,
    );
  }

  const failures = analyses.filter(entry => entry.error !== undefined).length;
  logger.info(
    {
      analyzed: analyses.length,
      failures,
      elapsedMs: Date.now() - startedAt,
    },
    'cli finished',
  );
  return failures === analyses.length ? 1 : 0;
}

process.exitCode = await main();
