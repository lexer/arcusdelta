/**
 * Entrypoint for `npm run monitor` — watch open positions and close them once
 * the pool has shifted fully to one side.
 *
 * This is a long-running, unattended loop that moves real funds without
 * prompting. `--dry-run` performs the full detection path and reports what it
 * would do while sending nothing.
 */

import {Command} from 'commander';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {print} from './prompt.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('monitor')
    .description('Watch liquidity positions and exit when they go one-sided')
    .option('--dry-run', 'detect and report without sending any transaction')
    .option('--token-id <id>', 'watch only this position')
    .option('--max-polls <n>', 'stop after this many checks')
    .parse(process.argv);
  const options = program.opts<{
    dryRun?: boolean;
    tokenId?: string;
    maxPolls?: string;
  }>();

  const config = loadConfig();
  const container = createContainer(config);
  const {logger, wallet} = container;
  const dryRun = options.dryRun === true;
  const startedAt = Date.now();

  logger.info(
    {command: 'monitor', dryRun, ...loggableConfig(config)},
    'cli started',
  );
  logger.info({walletAddress: wallet.getAccount().address}, 'wallet derived');

  if (!dryRun) {
    print('');
    print('Running unattended: positions will be closed and the stock token');
    print('sold automatically when the pool goes one-sided. Ctrl-C to stop.');
    print('');
  }

  try {
    const monitor = await container.createMonitor(dryRun);
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
