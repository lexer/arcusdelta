/**
 * Entrypoint for `npm run exit` — manually withdraw from the pool, claim fees,
 * and sell the stock token back to USDG on Arcus.
 *
 * The same flow the monitor runs automatically when a position goes one-sided,
 * triggered by hand and gated on a confirmation.
 */

import {Command} from 'commander';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {createPoolReader} from '../uniswap/poolReader.js';
import {createPositionReader} from '../uniswap/positionReader.js';
import {runExitCommand} from './exitCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('exit')
    .description(
      'Withdraw liquidity, claim fees, and sell the stock token back to USDG',
    )
    .option('-y, --yes', 'skip the interactive confirmation')
    .option('--dry-run', 'report what would happen without sending anything')
    .option('--token-id <id>', 'exit only this position')
    .parse(process.argv);
  const options = program.opts<{
    yes?: boolean;
    dryRun?: boolean;
    tokenId?: string;
  }>();

  const config = loadConfig();
  const container = createContainer(config);
  const {logger, wallet} = container;
  const startedAt = Date.now();
  const owner = wallet.getAccount().address;

  logger.info(
    {
      command: 'exit',
      dryRun: options.dryRun === true,
      ...loggableConfig(config),
    },
    'cli started',
  );
  logger.info({walletAddress: owner}, 'wallet derived');

  try {
    const exitService = await container.createExitService();
    const {usdg, stock} = exitService.tokens;
    const pool = exitService.pool;

    const poolReader = createPoolReader(wallet.getPublicClient());
    const positionReader = createPositionReader(
      wallet.getPublicClient(),
      config.chainId,
    );

    const [poolState, positions] = await Promise.all([
      poolReader.readState(pool),
      options.tokenId
        ? positionReader
            .read(BigInt(options.tokenId), pool, owner)
            .then(p => (p ? [p] : []))
        : positionReader.discover(pool, owner),
    ]);

    if (options.tokenId && positions.length === 0) {
      logger.error(
        {tokenId: options.tokenId},
        'requested position is not an open position of this wallet in this pool',
      );
      process.stderr.write(
        `Position ${options.tokenId} is not an open position of this wallet in this pool.\n`,
      );
      return 1;
    }

    const results = await runExitCommand({
      usdg,
      stock,
      positions,
      sqrtPriceX96: poolState.sqrtPriceX96,
      exitService,
      confirm: options.yes ? alwaysYes : promptYes,
      print,
      dryRun: options.dryRun === true,
    });

    const outcome = results === undefined ? 'aborted' : 'exited';
    logger.info(
      {
        outcome,
        exited: results?.length ?? 0,
        elapsedMs: Date.now() - startedAt,
      },
      'cli finished',
    );
    return results === undefined ? 1 : 0;
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
