/**
 * Entrypoint for `npm run monitor` — watch open positions across every
 * configured symbol (or just `--symbol`) and close them once their pool has
 * shifted fully to one side.
 *
 * This is a long-running, unattended loop that moves real funds without
 * prompting. `--dry-run` performs the full detection path and reports what it
 * would do while sending nothing.
 */

import {Command} from 'commander';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {print} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('monitor')
    .description('Watch liquidity positions and exit when they go one-sided')
    .option('--dry-run', 'detect and report without sending any transaction')
    .option('--symbol <ticker>', 'watch only this configured symbol')
    .option(
      '--token-id <id>',
      'watch only this position (requires --symbol, since a token id alone does not say which pool it is in)',
    )
    .option('--max-polls <n>', 'stop after this many checks')
    .parse(process.argv);
  const options = program.opts<{
    dryRun?: boolean;
    symbol?: string;
    tokenId?: string;
    maxPolls?: string;
  }>();

  const config = loadConfig();
  const symbols = loadSelectedSymbols(config, options.symbol);
  const container = createContainer(config);
  const {logger, wallet} = container;
  const dryRun = options.dryRun === true;
  const startedAt = Date.now();

  logger.info(
    {
      command: 'monitor',
      dryRun,
      symbols: symbols.map(s => s.symbol),
      ...loggableConfig(config),
    },
    'cli started',
  );
  logger.info({walletAddress: wallet.getAccount().address}, 'wallet derived');

  if (options.tokenId !== undefined && symbols.length !== 1) {
    const message =
      '--token-id requires exactly one symbol; pass --symbol too.';
    logger.error({tokenId: options.tokenId}, message);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  if (!dryRun) {
    print('');
    print('Running unattended: positions will be closed and the stock token');
    print('sold automatically when the pool goes one-sided. Ctrl-C to stop.');
    print('');
  }

  try {
    const monitor = await container.createMonitor(symbols, dryRun);
    await monitor.run({
      ...(options.tokenId ? {tokenId: BigInt(options.tokenId)} : {}),
      ...(options.maxPolls ? {maxPolls: Number(options.maxPolls)} : {}),
    });

    logger.info({elapsedMs: Date.now() - startedAt}, 'cli finished');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      {error: message, elapsedMs: Date.now() - startedAt},
      'cli failed',
    );
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
